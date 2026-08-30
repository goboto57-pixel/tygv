import express from "express";
import archiver from "archiver";
import { v4 as uuid } from "uuid";
import { saveJson, loadJson, listJson, deleteJson } from "../services/cloudinaryService.js";
import { gitLog, gitDiff, gitShow } from "../services/gitService.js";
import { deployToVercel, getDeployStatus, deleteVercelProject } from "../services/deployService.js";

const router = express.Router();
import { withChatWriteLock } from "../services/chatWriteLock.js";

// --- Chat history ---

router.get("/chats", async (req, res) => {
  try {
    const resources = await listJson("chat", 100);
    const results = await Promise.allSettled(
      resources.map(async (r) => {
        const id = r.public_id.split("/").pop();
        try {
          const data = await loadJson(id, "chat");
          return {
            id,
            title: data?.title || data?.messages?.[0]?.content?.slice(0, 60) || "Untitled chat",
            updatedAt: data?.updatedAt || r.created_at,
            messageCount: data?.messages?.length || 0
          };
        } catch {
          return null;
        }
      })
    );
    const items = results.map((r) => r.value).filter(Boolean);
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
    let id = req.body.id;
    // Validate custom ID or generate
    if (id) {
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{4,64}$/.test(id)) {
        return res.status(400).json({ error: "invalid id format" });
      }
      // Prevent overwriting existing chat without explicit intent
      const existing = await loadJson(id, "chat");
      if (existing) return res.status(409).json({ error: "chat already exists" });
    } else {
      id = uuid();
    }
    const safeBody = {};
    if (typeof req.body.title === "string") safeBody.title = req.body.title.slice(0, 120);
    if (Array.isArray(req.body.messages)) safeBody.messages = req.body.messages.slice(0, 200);
    if (Array.isArray(req.body.files)) safeBody.files = req.body.files.slice(0, 200);
    await saveJson(id, { ...safeBody, id, updatedAt: new Date().toISOString() }, "chat");
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

// Persist manual file edits (e.g. inline CodeViewer autosave) without
// touching message history. Merges into the existing chat record so a
// page reload never loses an edit the user made outside the agent loop.
router.patch("/chats/:id/files", async (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: "files array required" });
    }
    if (files.length > 200) return res.status(400).json({ error: "too many files (max 200)" });
    for (const f of files) {
      if (!f.path || typeof f.path !== "string" || f.path.length > 300) return res.status(400).json({ error: "invalid file path" });
      if (f.content && typeof f.content === "string" && f.content.length > 1024 * 1024) return res.status(400).json({ error: "file too large" });
    }
    await withChatWriteLock(req.params.id, async () => {
      const existing = (await loadJson(req.params.id, "chat")) || { id: req.params.id, messages: [] };
      await saveJson(
        req.params.id,
        { ...existing, id: req.params.id, files, updatedAt: new Date().toISOString() },
        "chat"
      );
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// also accept POST for sendBeacon fallback (beacon can only do POST)
router.post("/chats/:id/files", async (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files)) return res.status(400).json({ error: "files array required" });
    if (files.length > 200) return res.status(400).json({ error: "too many files" });
    await withChatWriteLock(req.params.id, async () => {
      const existing = (await loadJson(req.params.id, "chat")) || { id: req.params.id, messages: [] };
      await saveJson(req.params.id, { ...existing, id: req.params.id, files, updatedAt: new Date().toISOString() }, "chat");
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Persist manual message edits (e.g. user editing a prior prompt) without
// touching file state. Used for "edit message" flow in the UI.
router.patch("/chats/:id/messages", async (req, res) => {
  try {
    const { messages, title } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }
    if (messages.length > 200) return res.status(400).json({ error: "too many messages" });
    await withChatWriteLock(req.params.id, async () => {
      const existing = (await loadJson(req.params.id, "chat")) || { id: req.params.id, messages: [] };
      const next = { ...existing, id: req.params.id, messages };
      if (Array.isArray(req.body.uiMessages)) next.uiMessages = req.body.uiMessages.slice(0, 200);
      if (typeof title === "string" && title.trim()) next.title = title.trim().slice(0, 120);
      await saveJson(req.params.id, { ...next, updatedAt: new Date().toISOString() }, "chat");
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post("/chats/:id/messages", async (req, res) => {
  try {
    const { messages, title } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages array required" });
    await withChatWriteLock(req.params.id, async () => {
      const existing = (await loadJson(req.params.id, "chat")) || { id: req.params.id, messages: [] };
      const next = { ...existing, id: req.params.id, messages };
      if (Array.isArray(req.body.uiMessages)) next.uiMessages = req.body.uiMessages.slice(0, 200);
      if (typeof title === "string" && title.trim()) next.title = title.trim().slice(0, 120);
      await saveJson(req.params.id, { ...next, updatedAt: new Date().toISOString() }, "chat");
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Persist title and/or other lightweight session metadata without replacing history/files.
router.patch("/chats/:id/meta", async (req, res) => {
  try {
    let title;
    await withChatWriteLock(req.params.id, async () => {
      const existing = (await loadJson(req.params.id, "chat")) || { id: req.params.id, messages: [] };
      title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : existing.title;
      await saveJson(req.params.id, { ...existing, id: req.params.id, ...(title ? { title } : {}), updatedAt: new Date().toISOString() }, "chat");
    });
    res.json({ success: true, title });
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

// --- Git (real history reconstructed from snapshots) ---

async function loadOrderedSnapshots(chatId) {
  const resources = await listJson("snapshot", 200);
  const items = await Promise.all(
    resources.map(async (r) => loadJson(r.public_id.split("/").pop(), "snapshot"))
  );
  const filtered = items.filter((s) => s && s.chatId === chatId);
  filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest -> newest for replay
  return filtered;
}

router.get("/git/:chatId/log", async (req, res) => {
  try {
    const snapshots = await loadOrderedSnapshots(req.params.chatId);
    if (!snapshots.length) return res.json({ commits: [] });
    const commits = await gitLog(snapshots);
    res.json({ commits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/git/:chatId/diff", async (req, res) => {
  try {
    const snapshots = await loadOrderedSnapshots(req.params.chatId);
    if (snapshots.length < 2) return res.json({ diff: "", stat: "", note: "Need at least 2 snapshots to diff." });
    // Accept snapshot IDs (preferred — unambiguous) or fall back to
    // numeric indices into the oldest->newest order used for replay.
    const idToIndex = new Map(snapshots.map((s, i) => [s.id, i]));
    const resolve = (val) => {
      if (val === undefined) return undefined;
      if (idToIndex.has(val)) return idToIndex.get(val);
      const n = Number(val);
      return Number.isInteger(n) ? n : undefined;
    };
    const from = resolve(req.query.from);
    const to = resolve(req.query.to);
    const result = await gitDiff(snapshots, { from, to });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/git/:chatId/show/:index", async (req, res) => {
  try {
    const snapshots = await loadOrderedSnapshots(req.params.chatId);
    const result = await gitShow(snapshots, Number(req.params.index));
    res.json(result);
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
    if (files.length > 500) return res.status(400).json({ error: "too many files (max 500)" });
    let totalSize = 0;
    for (const f of files) totalSize += String(f?.content || "").length;
    if (totalSize > 20 * 1024 * 1024) return res.status(400).json({ error: "project too large (max 20MB)" });

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    });
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${(projectName || "codeforge-project").replace(/[^a-zA-Z0-9._-]/g, "_")}.zip"`
    });
    archive.pipe(res);

    for (const file of files) {
      const rawPath = String(file?.path || "").replace(/\\/g, "/");
      const safePath = rawPath.replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
      if (!safePath) continue;
      archive.append(String(file?.content || ""), { name: safePath });
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// --- Deploy to hosting (Vercel) ---
// The user never provides credentials — deployment happens under our own
// Vercel account (VERCEL_TOKEN in env, plus VERCEL_TEAM_ID if that token is
// team-scoped — see deployService.js). Each chat is mapped to at most one
// Vercel project, persisted alongside the chat record, so re-deploying the
// same chat updates the same project/URL instead of minting a new one every
// time.

router.post("/deploy", async (req, res) => {
  try {
    const { chatId, files, projectName } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "files array required" });
    }
    if (files.length > 500) return res.status(400).json({ error: "too many files (max 500)" });
    let totalSize = 0;
    for (const f of files) totalSize += String(f?.content || "").length;
    if (totalSize > 20 * 1024 * 1024) return res.status(400).json({ error: "project too large (max 20MB)" });

    const safeFiles = files
      .map((f) => ({
        path: String(f?.path || "").replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((p) => p && p !== "." && p !== "..").join("/"),
        content: f?.content ?? ""
      }))
      .filter((f) => f.path);

    let existing = null;
    if (chatId) existing = await loadJson(chatId, "chat");

    const result = await deployToVercel({
      files: safeFiles,
      existingSiteId: existing?.deploy?.siteId,
      siteNameHint: projectName || existing?.title || chatId
    });

    if (chatId) {
      await withChatWriteLock(chatId, async () => {
        const current = (await loadJson(chatId, "chat")) || { id: chatId, messages: [] };
        // Keep a bounded history of past publishes for this chat (newest
        // first) so the UI can offer "revert to a previous published
        // version" without needing a separate Vercel API round-trip.
        const prevHistory = Array.isArray(current.deployHistory) ? current.deployHistory : [];
        const entry = { siteId: result.siteId, url: result.url, deployId: result.deployId, deployedAt: new Date().toISOString(), fileCount: safeFiles.length };
        const deployHistory = [entry, ...prevHistory].slice(0, 20);
        await saveJson(
          chatId,
          {
            ...current,
            id: chatId,
            deploy: entry,
            deployHistory,
            updatedAt: new Date().toISOString()
          },
          "chat"
        );
      });
    }

    res.json({ url: result.url, siteId: result.siteId, deployId: result.deployId, createdNew: result.createdNew });
  } catch (err) {
    if (err.code === "NO_TOKEN") return res.status(503).json({ error: err.message });
    if (err.code === "NO_INDEX") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message || "Deploy failed" });
  }
});

// Poll a specific deploy's processing state ("building"/"processing" ->
// "ready"/"error"). The client uses this right after POST /deploy to show a
// "публикуется…" state instead of assuming the site is live immediately —
// Vercel accepts the deploy synchronously but processes (builds) it asynchronously.
router.get("/deploy/:deployId/status", async (req, res) => {
  try {
    const status = await getDeployStatus(req.params.deployId);
    res.json({ state: status.state, url: status.ssl_url || status.url, deployId: status.id });
  } catch (err) {
    if (err.code === "NO_TOKEN") return res.status(503).json({ error: err.message });
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message || "Status check failed" });
  }
});

// Publish history for a chat — lets the UI list past published versions.
router.get("/deploy/:chatId/history", async (req, res) => {
  try {
    const existing = await loadJson(req.params.chatId, "chat");
    res.json({ deploy: existing?.deploy || null, history: existing?.deployHistory || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Takes a chat's published site down entirely (deletes the project on Vercel).
// Clears the chat's `deploy` pointer so the next publish creates a fresh
// site rather than trying to redeploy to something that no longer exists.
router.delete("/deploy/:chatId", async (req, res) => {
  try {
    const existing = await loadJson(req.params.chatId, "chat");
    const siteId = existing?.deploy?.siteId;
    if (!siteId) return res.status(404).json({ error: "У этого чата нет опубликованного сайта" });
    await deleteVercelProject(siteId);
    await withChatWriteLock(req.params.chatId, async () => {
      const current = (await loadJson(req.params.chatId, "chat")) || { id: req.params.chatId, messages: [] };
      const { deploy, ...rest } = current;
      await saveJson(req.params.chatId, { ...rest, id: req.params.chatId, updatedAt: new Date().toISOString() }, "chat");
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === "NO_TOKEN") return res.status(503).json({ error: err.message });
    res.status(err.status === 404 ? 404 : 500).json({ error: err.message || "Не удалось снять сайт с публикации" });
  }
});

export default router;
