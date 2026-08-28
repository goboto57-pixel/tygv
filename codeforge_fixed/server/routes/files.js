import express from "express";
import multer from "multer";
import { uploadRawFile } from "../services/cloudinaryService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 10 } });

const TEXT_EXTENSIONS = [
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".rb", ".php",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".html", ".css", ".scss", ".json",
  ".md", ".txt", ".yml", ".yaml", ".xml", ".sql", ".sh", ".env", ".vue", ".svelte"
];

function isTextFile(name) {
  // also treat files without extension but known text names as text
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  const textNames = new Set(["dockerfile", "makefile", "procfile", "readme", "license"]);
  const base = lower.split("/").pop().split(".")[0];
  if (textNames.has(base)) return true;
  // if no extension, try to detect as text via buffer check done elsewhere, but default to text for extensionless
  if (!lower.includes(".") && lower.length < 32) return true;
  return false;
}

function sanitizePath(name) {
  // keep unicode letters (Cyrillic etc), allow spaces/dots/dash, block traversal
  let p = name.replace(/\0/g, "").replace(/\\/g, "/");
  p = p.replace(/\.\.\//g, "").replace(/\.\./g, "");
  p = p.replace(/^\/+/, "");
  // allow unicode letters/numbers, dot, dash, underscore, slash, space
  p = p.replace(/[^\p{L}\p{N}._\-\/ ]/gu, "_");
  p = p.replace(/\s+/g, " ").trim();
  if (!p || p.length > 200) p = p.slice(0, 200) || "unnamed";
  return p;
}

router.post("/upload", upload.array("files", 10), async (req, res) => {
  try {
    const results = [];
    for (const file of req.files || []) {
      const safePath = sanitizePath(file.originalname);
      if (isTextFile(safePath)) {
        // limit content to 1MB per file to avoid OOM
        const str = file.buffer.toString("utf-8");
        const content = str.length > 1024 * 1024 ? str.slice(0, 1024 * 1024) + "\n[truncated]" : str;
        results.push({
          path: safePath,
          content,
          isText: true
        });
      } else {
        const { url } = await uploadRawFile(file.buffer, safePath);
        results.push({
          path: safePath,
          url,
          isText: false
        });
      }
    }
    res.json({ files: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
