import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

import chatRoutes from "./routes/chat.js";
import fileRoutes from "./routes/files.js";
import projectRoutes from "./routes/projects.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "*",
    credentials: true
  })
);
app.use(express.json({ limit: "40mb" })); // raised for base64 image attachments (vision input)

// Required for @webcontainer/api in the client (SharedArrayBuffer / cross-
// origin isolation). "credentialless" rather than "require-corp": the latter
// would also break the Google Fonts <link> in index.html, since
// fonts.googleapis.com doesn't send Cross-Origin-Resource-Policy.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", limiter);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: process.env.MISTRAL_MODEL || "codestral-latest" });
});

app.use("/api/chat", chatRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/projects", projectRoutes);

// Serve the built React client (client/dist) as static files.
// This lets a single Node service host both the API and the frontend.
const clientDistPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDistPath));

// SPA fallback: any non-API route returns index.html so client-side routing works.
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(clientDistPath, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`CodeForge server running on port ${PORT}`);
});
