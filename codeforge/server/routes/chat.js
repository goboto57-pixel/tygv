import express from "express";
import multer from "multer";
import { runAgentLoop } from "../services/agentLoop.js";
import { saveJson } from "../services/cloudinaryService.js";
import { transcribeAudio } from "../services/mistralClient.js";

const router = express.Router();
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

router.post("/stream", async (req, res) => {
  const { history, files, chatId, model, mode, enhance, images } = req.body;

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
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const outcome = await runAgentLoop({
      history,
      files: files || [],
      model,
      mode: mode || "single",
      enhance: enhance !== false,
      images: Array.isArray(images) ? images : undefined,
      signal: controller.signal,
      onEvent: send
    });

    if (chatId) {
      await saveJson(
        chatId,
        {
          id: chatId,
          messages: outcome.messages,
          files: outcome.files,
          updatedAt: new Date().toISOString()
        },
        "chat"
      );
    }

    send({ type: "done" });
  } catch (err) {
    send({ type: "error", message: err.message });
  } finally {
    res.end();
  }
});

export default router;
