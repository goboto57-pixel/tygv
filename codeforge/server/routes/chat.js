import express from "express";
import multer from "multer";
import { runAgentLoop } from "../services/agentLoop.js";
import { saveJson, loadJson } from "../services/cloudinaryService.js";
import { transcribeAudio } from "../services/mistralClient.js";
import { createPendingApproval, resolveApproval } from "../services/approvalHub.js";

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
  const { approved } = req.body;
  const ok = resolveApproval(req.params.token, approved === true);
  if (!ok) {
    return res.status(404).json({ error: "No pending approval for this token (it may have already timed out or been resolved)." });
  }
  res.json({ success: true });
});

router.post("/stream", async (req, res) => {
  const { history, files, chatId, memoryKey, model, mode, enhance, images, requireApproval, autoRollback } = req.body;

  if (!history || !Array.isArray(history)) {
    return res.status(400).json({ error: "history array is required" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const send = (event) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  // Bridges runAgentLoop's diff-approval gate to a real user click: emits
  // a `diff_pending` event carrying a token (added on top of what
  // agentLoop already sends), then waits on the Promise that the
  // POST /chat/approve/:token route resolves.
  const onApprovalNeeded = requireApproval
    ? ({ path, kind, before, after }) => {
        const { token, promise } = createPendingApproval();
        send({ type: "diff_pending", token, path, kind, before, after });
        return promise;
      }
    : undefined;

  try {
    const outcome = await runAgentLoop({
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
      autoRollbackOnTestFailure: autoRollback !== false,
      signal: controller.signal,
      onEvent: send
    });

    if (chatId) {
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
    }

    send({ type: "done" });
  } catch (err) {
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

export default router;
