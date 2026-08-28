import express from "express";
import multer from "multer";
import { uploadRawFile } from "../services/cloudinaryService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const TEXT_EXTENSIONS = [
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".rb", ".php",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".html", ".css", ".scss", ".json",
  ".md", ".txt", ".yml", ".yaml", ".xml", ".sql", ".sh", ".env", ".vue", ".svelte"
];

function isTextFile(name) {
  return TEXT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

router.post("/upload", upload.array("files", 20), async (req, res) => {
  try {
    const results = [];
    for (const file of req.files || []) {
      if (isTextFile(file.originalname)) {
        results.push({
          path: file.originalname,
          content: file.buffer.toString("utf-8"),
          isText: true
        });
      } else {
        const { url } = await uploadRawFile(file.buffer, file.originalname);
        results.push({
          path: file.originalname,
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
