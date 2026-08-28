import express from "express";
import archiver from "archiver";
import { v4 as uuid } from "uuid";
import { saveJson, loadJson, listJson, deleteJson } from "../services/cloudinaryService.js";

const router = express.Router();

// --- Chat history ---

router.get("/chats", async (req, res) => {
  try {
    const resources = await listJson("chat", 100);
    const items = await Promise.all(
      resources.map(async (r) => {
        const id = r.public_id.split("/").pop();
        const data = await loadJson(id, "chat");
        return {
          id,
          title: data?.title || data?.messages?.[0]?.content?.slice(0, 60) || "Untitled chat",
          updatedAt: data?.updatedAt || r.created_at,
          messageCount: data?.messages?.length || 0
        };
      })
    );
    items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json({ chats: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/chats/:id", async (req, res) => {
  try {
    const data = await loadJson(req.params.id, "chat");
    if (!data) return res.status(404).json({ error: "Chat not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/chats", async (req, res) => {
  try {
    const id = req.body.id || uuid();
    await saveJson(id, { ...req.body, id, updatedAt: new Date().toISOString() }, "chat");
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/chats/:id", async (req, res) => {
  try {
    await deleteJson(req.params.id, "chat");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Snapshots (version checkpoints) ---

router.post("/snapshots", async (req, res) => {
  try {
    const id = uuid();
    const { chatId, label, files } = req.body;
    await saveJson(
      id,
      { id, chatId, label, files, createdAt: new Date().toISOString() },
      "snapshot"
    );
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/snapshots/:chatId", async (req, res) => {
  try {
    const resources = await listJson("snapshot", 200);
    const items = await Promise.all(
      resources.map(async (r) => {
        const id = r.public_id.split("/").pop();
        return loadJson(id, "snapshot");
      })
    );
    const filtered = items.filter((s) => s && s.chatId === req.params.chatId);
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ snapshots: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Export project as ZIP ---

router.post("/export-zip", async (req, res) => {
  try {
    const { files, projectName } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: "files array required" });
    }

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${(projectName || "codeforge-project").replace(/[^a-zA-Z0-9._-]/g, "_")}.zip"`
    });

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    for (const file of files) {
      archive.append(file.content || "", { name: file.path });
    }

    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
