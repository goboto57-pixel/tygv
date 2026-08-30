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
// Agent turns can carry large file trees, so allow a generous body size.
// (Render's default 100kb proxy limit is raised via express limit here.)
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

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

// App-secret gate: every /api/* request (from the website's own frontend or
// the Android app) must carry the shared secret in the X-App-Secret header,
// or it's rejected. This is meant to keep out automated bots/scripts that
// scan for open API endpoints and hammer them directly — it is NOT meant to
// stop a determined attacker who reads the page source, since the secret is
// necessarily shipped inside the built client bundle (visible in DevTools)
// and inside the Android APK (extractable with reverse-engineering tools).
// That's an inherent limit of any secret embedded in a public client with no
// real user-auth system — full protection would require login/API keys per
// user instead.
//
// Set APP_SHARED_SECRET in the Render environment (and the same value in the
// client's VITE_APP_SECRET build env + the Android app's Constants.kt) to
// enable this. If APP_SHARED_SECRET is not set on the server, the gate is a
// no-op and every request passes through unchanged (dev-friendly default).
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || "";
app.use("/api", (req, res, next) => {
  if (!APP_SHARED_SECRET) return next(); // gate disabled unless configured
  if (req.path === "/health") return next(); // let uptime monitors ping freely
  const provided = req.headers["x-app-secret"];
  if (provided !== APP_SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Rate limiting with different limits for different endpoints
// Use per-chatId or per-user key instead of just IP (Render shares IPs)
const getRateLimitKey = (req) => {
  return req.body?.chatId || req.body?.memoryKey || req.headers["x-workspace-id"] || req.ip;
};
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getRateLimitKey(req) || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests, please try again later." });
  },
  skip: (req) => req.path === "/health" || req.path === "/api/health"
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getRateLimitKey(req) || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many chat requests, please wait a moment." });
  }
});

// Deploys hit a real, shared Vercel account — cap them harder than general
// API traffic so one chat spamming "опубликуй" can't exhaust the account's
// Vercel API rate limit for everyone else.
const deployLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => getRateLimitKey(req) || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: "Слишком много публикаций подряд — подождите пару минут." });
  }
});

// Request timeout for SSE and large uploads. The /chat/stream SSE connection
// is only a *subscriber* to a detached server-side job that may run for many
// minutes — never time it out, or the live display would freeze while the
// agent keeps working. We disable the timeout purely for that endpoint.
app.use((req, res, next) => {
  if (req.path === "/api/chat/stream" || req.path.startsWith("/api/chat/abort")) {
    req.setTimeout(0);
    res.setTimeout(0);
    return next();
  }
  req.setTimeout(120000);
  res.setTimeout(120000);
  next();
});

app.use("/api", apiLimiter);
app.use("/api/chat", chatLimiter);
app.use("/api/projects/deploy", deployLimiter);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: process.env.MISTRAL_MODEL || "codestral-latest" });
});
app.get("/api/metrics", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    memory: { rss: Math.round(mem.rss / 1024 / 1024) + "MB", heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + "MB" },
    model: process.env.MISTRAL_MODEL || "codestral-latest",
    time: new Date().toISOString()
  });
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
