import { randomUUID } from "crypto";
import { runAgentLoop } from "./agentLoop.js";

// In-memory registry of background agent jobs, keyed by a client-supplied
// `runId`. A job is fully detached from the HTTP request that started it: the
// SSE connection only subscribes to the job's event stream. If the client
// disconnects (closes the tab, navigates away, loses connection) the job keeps
// running on the server and keeps persisting the chat. A new connection that
// arrives with the same `runId` replays every buffered event from the start
// and then tails new ones live, so the user sees the full answer on return.

const jobs = new Map();

// Tracks the single "current" runId per chatId. Jobs are detached (a job
// keeps running server-side even if its SSE connection drops), so without
// this a client that silently loses its stream — proxy idle timeout, network
// blip, or just switching model/resending before confirming the old job
// ended — can start a SECOND job against the same chat while the first one
// is still mutating files and about to persist. Both then race to save the
// chat document, and the client ends up with an inconsistent mix of two
// runs' events, which is what tends to crash the UI. We only ever let one
// job per chatId run at a time.
const activeRunByChat = new Map(); // chatId -> runId

// Bound how much history we keep per job so a very long run can't OOM the server.
const MAX_BUFFERED_EVENTS = 4000;
// After a job finishes we keep its buffer around for a while to allow late
// reconnects, then evict it to free memory.
const DONE_TTL_MS = 15 * 60 * 1000;

function evict(job) {
  if (job._ttl) clearTimeout(job._ttl);
  jobs.delete(job.id);
}

export function getJob(runId) {
  return jobs.get(runId) || null;
}

/**
 * Returns the runId of the currently-running job for a chatId, if any (and
 * still actually running — a finished job's mapping is cleared).
 */
export function getActiveRunForChat(chatId) {
  if (!chatId) return null;
  const runId = activeRunByChat.get(chatId);
  if (!runId) return null;
  const job = jobs.get(runId);
  if (!job || job.status !== "running") {
    activeRunByChat.delete(chatId);
    return null;
  }
  return runId;
}

/**
 * Starts a new job or attaches to an existing (still-running or just-finished)
 * one identified by `runId`. Returns { job, isNew }.
 *
 * params: everything runAgentLoop needs (history, files, model, mode, ...).
 * onPersist: async (outcome) => void  called once when the turn completes so
 *            the chat document is saved even if no client is connected.
 */
export function startOrResumeJob({ runId, params, onPersist }) {
  const existing = jobs.get(runId);
  if (existing) {
    // Reuse the in-flight job. Reset its eviction timer since it's active again.
    if (existing._ttl) {
      clearTimeout(existing._ttl);
      existing._ttl = null;
    }
    return { job: existing, isNew: false };
  }

  const job = {
    id: runId,
    status: "running", // running | done | error
    events: [],
    listeners: new Set(),
    abortController: new AbortController(),
    finalState: null,
    error: null,
    createdAt: Date.now(),
    chatId: params?.chatId || null,
    _ttl: null
  };
  jobs.set(runId, job);
  if (params?.chatId) activeRunByChat.set(params.chatId, runId);

  const emit = (event) => {
    job.events.push(event);
    if (job.events.length > MAX_BUFFERED_EVENTS) job.events.shift();
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener must not break the job
      }
    }
  };

  runAgentLoop({
    ...params,
    onEvent: emit,
    signal: job.abortController.signal
  })
    .then(async (outcome) => {
      job.status = "done";
      job.finalState = outcome;

      // Persist BEFORE emitting "done": the client's SSE connection closes
      // on "done" (see routes/chat.js res.end()), so anything emitted after
      // that point never reaches the browser. Persistence used to run
      // after "done" with its error silently swallowed (bare `catch {}`,
      // not even logged) — meaning if Cloudinary env vars were missing or
      // wrong, EVERY chat/file save failed forever with zero visibility to
      // either the server logs or the user. That's the actual cause of
      // "chats and files aren't saving": it wasn't a UI bug, saves were
      // failing silently on every single turn.
      if (params.chatId && typeof onPersist === "function") {
        try {
          await onPersist(outcome);
        } catch (err) {
          console.error(`[jobManager] persistence failed for chatId=${params.chatId}:`, err);
          emit({
            type: "status",
            text: `⚠ Не удалось сохранить чат/файлы (${err?.message || "ошибка хранилища"}). Проверьте переменные окружения хранилища на сервере.`
          });
        }
      }

      emit({ type: "done" });
      scheduleEvict(job);
    })
    .catch((err) => {
      job.status = "error";
      job.error = err?.message || String(err);
      console.error(`[jobManager] job ${job.id} (chatId=${job.chatId || "?"}) failed:`, err);
      emit({ type: "error", message: job.error });
      scheduleEvict(job);
    });

  return { job, isNew: true };
}

function scheduleEvict(job) {
  if (job._ttl) clearTimeout(job._ttl);
  job._ttl = setTimeout(() => evict(job), DONE_TTL_MS);
  // Free up the chatId slot as soon as the job is done/errored, not just on
  // eviction, so a legitimate next turn for this chat isn't blocked for
  // DONE_TTL_MS waiting on a job that already finished.
  if (job.chatId && activeRunByChat.get(job.chatId) === job.id) {
    activeRunByChat.delete(job.chatId);
  }
}

/**
 * Subscribes `onEvent` to a job's stream. Immediately replays every buffered
 * event (caller should reset its UI state first), then delivers live events.
 * Returns an unsubscribe function. The returned promise resolves when the job
 * has already finished (so the caller knows there is no more live tailing).
 */
export function subscribe(runId, onEvent) {
  const job = jobs.get(runId);
  if (!job) {
    // Unknown runId (e.g. server restarted) — signal so caller can restart.
    onEvent({ type: "job_not_found", runId });
    return () => {};
  }

  // Replay buffered events so a reconnecting client reconstructs full state.
  // The terminal `done`/`error` event is part of the buffer itself, so no
  // extra emission is needed here.
  for (const event of job.events) {
    try {
      onEvent(event);
    } catch {}
  }

  job.listeners.add(onEvent);
  return () => {
    job.listeners.delete(onEvent);
  };
}

export function abortJob(runId) {
  const job = jobs.get(runId);
  if (job && job.status === "running") {
    job.abortController.abort();
    job.status = "error";
    job.error = "aborted";
  }
}

export function generateRunId() {
  return randomUUID();
}
