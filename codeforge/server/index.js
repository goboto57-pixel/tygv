import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";

import chatRoutes from "./routes/chat.js";
import fileRoutes from "./routes/files.js";
import projectRoutes from "./routes/projects.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Trust proxy for correct IP detection behind reverse proxies (Render, etc.)
app.set("trust proxy", 1);

// Compression for all responses
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path === "/api/chat/stream" || req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  }
}));

const allowedOrigins = (process.env.CLIENT_ORIGIN || "").split(",").map((v) => v.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : (process.env.NODE_ENV === "production" ? false : true),
    credentials: allowedOrigins.length > 0,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Required for @webcontainer/api in the client (SharedArrayBuffer / cross-
// origin isolation). "credentialless" rather than "require-corp": the latter
// would also break the Google Fonts <link> in index.html, since
// fonts.googleapis.com doesn't send Cross-Origin-Resource-Policy.
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Security headers
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Rate limiting with different limits for different endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests, please try again later." });
  }
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many chat requests, please wait." });
  }
});

// Request timeout for SSE and large uploads
app.use((req, res, next) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  next();
});

app.use("/api", apiLimiter);
app.use("/api/chat", chatLimiter);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: process.env.MISTRAL_MODEL || "codestral-latest" });
});

app.use("/api/chat", chatRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/projects", projectRoutes);

// Serve the built React client (client/dist) as static files with long-term caching.
// This lets a single Node service host both the API and the frontend.
const clientDistPath = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDistPath, {
  maxAge: "1y",
  immutable: true,
  etag: true,
  lastModified: true,
  setHeaders: (res, path) => {
    if (path.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
}));

// SPA fallback: any non-API route returns index.html so client-side routing works.
// Use /*splat for express@5 compatibility
app.get("/*splat", (req, res, next) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(clientDistPath, "index.html"), { etag: true, lastModified: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
  if (err.status === 429) return res.status(429).json({ error: "Too many requests" });
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`CodeForge server running on port ${PORT}`);
});
