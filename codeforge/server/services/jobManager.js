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
    _ttl: null
  };
  jobs.set(runId, job);

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
      emit({ type: "done" });
      if (params.chatId && typeof onPersist === "function") {
        try {
          await onPersist(outcome);
        } catch {
          // persistence best-effort; the client still has the streamed events
        }
      }
      scheduleEvict(job);
    })
    .catch((err) => {
      job.status = "error";
      job.error = err?.message || String(err);
      emit({ type: "error", message: job.error });
      scheduleEvict(job);
    });

  return { job, isNew: true };
}

function scheduleEvict(job) {
  if (job._ttl) clearTimeout(job._ttl);
  job._ttl = setTimeout(() => evict(job), DONE_TTL_MS);
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
