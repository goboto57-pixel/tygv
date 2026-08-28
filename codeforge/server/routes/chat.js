import express from "express";
import multer from "multer";
import { runAgentLoop } from "../services/agentLoop.js";
import { saveJson, loadJson } from "../services/cloudinaryService.js";
import { transcribeAudio } from "../services/mistralClient.js";
import { createPendingApproval, resolveApproval } from "../services/approvalHub.js";
import { startOrResumeJob, subscribe, generateRunId, abortJob } from "../services/jobManager.js";
import { loadMemory, deleteMemoryEntry, clearMemory } from "../services/memoryService.js";

const router = express.Router();
import { withChatWriteLock } from "../services/chatWriteLock.js";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Voice prompt input: browser records audio, we ship it to Mistral Voxtral
// for transcription and hand back plain text for the chat input box.
router.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "audio file is required" });
    }
    const { text } = await transcribeAudio({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype
    });
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolves a pending diff-approval prompt raised mid-stream by a currently
// running /chat/stream call (see approvalHub.js for how the two connect).
router.post("/approve/:token", (req, res) => {
  const { approved, note } = req.body;
  const ok = resolveApproval(req.params.token, approved === true, note);
  if (!ok) {
    return res.status(404).json({ error: "No pending approval for this token (it may have already timed out or been resolved)." });
  }
  res.json({ success: true });
});

router.post("/stream", async (req, res) => {
  const {
    history, files, chatId, memoryKey, model, mode, enhance, images,
    requireApproval, autoRollback, runId: requestedRunId, resume,
    requirePlanApproval
  } = req.body;

  // A resume request only needs the runId; the job is already running on the
  // server with its own params. A fresh request must supply a full history.
  const isResume = resume === true && requestedRunId;

  if (!isResume) {
    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: "history array is required" });
    }
    if (history.length > 200) {
      return res.status(400).json({ error: "history too long (max 200 messages)" });
    }
  }
  if (chatId && typeof chatId !== "string") {
    return res.status(400).json({ error: "chatId must be string" });
  }
  if (chatId && !/^[a-zA-Z0-9_-]{4,64}$/.test(chatId)) {
    return res.status(400).json({ error: "invalid chatId format" });
  }
  if (!isResume && Array.isArray(files) && files.length > 200) {
    return res.status(400).json({ error: "too many files (max 200)" });
  }
  if (!isResume && Array.isArray(images) && images.length > 4) {
    return res.status(400).json({ error: "too many images (max 4)" });
  }
  // Validate image sizes (base64)
  if (!isResume && Array.isArray(images)) {
    for (const img of images) {
      if (img?.dataUrl && img.dataUrl.length > 8 * 1024 * 1024) {
        return res.status(400).json({ error: "image too large (max 8MB)" });
      }
    }
  }

  const runId = requestedRunId || generateRunId();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event) => {
    if (res.writableEnded || !res.writable) return;
    // Sanitize event to prevent SSE frame injection via newlines in payload
    const payload = JSON.stringify(event).replace(/\n/g, "\\n");
    res.write(`data: ${payload}\n\n`);
    if (typeof res.flush === "function") res.flush();
    // Terminal events: close the SSE response so the client's reader ends and
    // `isStreaming` flips back to false. The job itself keeps running detached.
    if (event.type === "done" || event.type === "error" || event.type === "job_not_found") {
      res.end();
    }
  };

  // Bridges runAgentLoop's diff-approval gate to a real user click: emits
  // a `diff_pending` event carrying a token (added on top of what
  // agentLoop already sends), then waits on the Promise that the
  // POST /chat/approve/:token route resolves. Only wired for the request that
  // actually starts the job; resumes attach to the existing job's stream.
  const onApprovalNeeded = requireApproval
    ? ({ path, kind, before, after }) => {
        const { token, promise } = createPendingApproval();
        send({ type: "diff_pending", token, path, kind, before, after });
        return promise;
      }
    : undefined;

  // Same bridge, but for plan approval. The agent pauses after make_plan and
  // waits for the user to approve (or reject with an optional note) via the
  // same token-resolving approval route. The emitted event type is
  // `plan_proposed` so the client can render a dedicated approval UI.
  const onPlanApproveNeeded = requirePlanApproval
    ? ({ plan }) => {
        const { token, promise } = createPendingApproval();
        send({ type: "plan_proposed", token, plan });
        return promise;
      }
    : undefined;

  const persistTurn = async (outcome) => {
    if (!chatId) return;
    // Merge with the existing document so client-side durable fields such as
    // uiMessages/title are not lost when the agent finishes its internal turn.
    await withChatWriteLock(chatId, async () => {
      const existing = (await loadJson(chatId, "chat")) || {};
      await saveJson(
        chatId,
        {
          ...existing,
          id: chatId,
          messages: outcome.messages,
          files: outcome.files,
          updatedAt: new Date().toISOString()
        },
        "chat"
      );
    });
  };

  if (isResume) {
    // Attach to the already-running (or finished) server-side job and replay
    // its buffered events. The job does NOT depend on this connection: if the
    // client goes away, the job keeps running and keeps persisting.
    send({ type: "resume_start", runId });
    const unsubscribe = subscribe(runId, (event) => {
      if (event.type === "job_not_found") {
        // Server lost the job (e.g. restart). Tell the client to restart fresh.
        send({ type: "job_not_found", runId });
        return;
      }
      send(event);
    });
    req.on("close", () => unsubscribe());
    return;
  }

  // Fresh turn: validate, then start (or resume if the same runId somehow
  // already exists) a detached background job.
  const { job, isNew } = startOrResumeJob({
    runId,
    params: {
      history,
      files: files || [],
      model,
      mode: mode || "single",
      enhance: enhance !== false,
      images: Array.isArray(images) ? images : undefined,
      chatId,
      memoryKey,
      requireApproval: !!requireApproval,
      onApprovalNeeded,
      requirePlanApproval: !!requirePlanApproval,
      onPlanApproveNeeded,
      autoRollbackOnTestFailure: autoRollback !== false
    },
    onPersist: persistTurn
  });

  send({ type: "run_started", runId, resumed: !isNew });

  const unsubscribe = subscribe(runId, send);
  req.on("close", () => {
    // IMPORTANT: do not abort the job. The agent continues on the server and
    // the chat is persisted regardless of whether a client is connected.
    unsubscribe();
  });
});

// Allows the client to cancel an in-flight detached job (e.g. user hits stop).
router.post("/abort/:runId", (req, res) => {
  abortJob(req.params.runId);
  res.json({ success: true });
});

// --- Project memory browser API (used by the client Memory panel) ---
router.get("/memory/:scopeId", async (req, res) => {
  const { scopeId } = req.params;
  if (!scopeId || !/^[a-zA-Z0-9_-]{1,120}$/.test(scopeId)) {
    return res.status(400).json({ error: "invalid scopeId" });
  }
  const entries = await loadMemory(scopeId);
  res.json({ entries });
});

router.delete("/memory/:scopeId/:entryId", async (req, res) => {
  const { scopeId, entryId } = req.params;
  try {
    const ok = await deleteMemoryEntry(scopeId, entryId);
    res.json({ deleted: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/memory/:scopeId/clear", async (req, res) => {
  try {
    await clearMemory(req.params.scopeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
