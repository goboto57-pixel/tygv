import express from "express";
import { runAgentLoop } from "../services/agentLoop.js";
import { saveJson } from "../services/cloudinaryService.js";

const router = express.Router();

router.post("/stream", async (req, res) => {
  const { history, files, chatId, model } = req.body;

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
