import { v2 as cloudinary } from "cloudinary";
import { v4 as uuid } from "uuid";

// Validate Cloudinary config early
const hasCloudinaryConfig = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (!hasCloudinaryConfig) {
  console.warn("[cloudinary] CLOUDINARY_* env vars not set - Cloudinary operations will fail");
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const FOLDER_PROJECTS = "codeforge/projects";
const FOLDER_CHATS = "codeforge/chats";
const FOLDER_UPLOADS = "codeforge/uploads";
const FOLDER_SNAPSHOTS = "codeforge/snapshots";
const FOLDER_MEMORY = "codeforge/memory";

// Simple in-memory cache for Cloudinary API responses with LRU and TTL
// TTL: 30 seconds for list operations, 60 seconds for individual loads
const CACHE_TTL = { list: 30000, load: 60000 };
const CACHE_MAX_SIZE = 200;
const cache = new Map();

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts >= ttl) {
    cache.delete(key);
    return null;
  }
  // LRU: move to end
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function setCache(key, data) {
  if (cache.size >= CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, ts: Date.now() });
}

function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    const ttl = k.startsWith("list:") ? CACHE_TTL.list : CACHE_TTL.load;
    if (now - v.ts >= ttl) cache.delete(k);
  }
}, 60000).unref?.();

function jsonToBase64(obj) {
  const json = JSON.stringify(obj);
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

/** Uploads any raw file buffer (used for user-uploaded project files) */
export async function uploadRawFile(buffer, originalName, folder = FOLDER_UPLOADS) {
  const safeName = String(originalName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  const publicId = `${folder}/${uuid()}-${safeName}`;
  if (publicId.length > 240) throw new Error("public_id too long");
  const result = await cloudinary.uploader.upload(
    `data:application/octet-stream;base64,${buffer.toString("base64")}`,
    {
      public_id: publicId,
      resource_type: "raw",
      overwrite: true
    }
  );
  return { url: result.secure_url, publicId: result.public_id };
}

/** Saves a JSON document (chat history, project file tree, snapshot) as a raw asset */
export async function saveJson(id, data, kind = "chat") {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : kind === "memory" ? FOLDER_MEMORY : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  const result = await cloudinary.uploader.upload(jsonToBase64(data), {
    public_id: publicId,
    resource_type: "raw",
    overwrite: true
  });
  // Invalidate only relevant cache entries
  invalidateCache(`load:${kind}:${id}`);
  invalidateCache(`list:${kind}`);
  return { url: result.secure_url, publicId: result.public_id };
}

/** Fetches a JSON document previously saved via saveJson */
export async function loadJson(id, kind = "chat") {
  const cacheKey = `load:${kind}:${id}`;
  const cached = getCached(cacheKey, CACHE_TTL.load);
  if (cached) return cached;

  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : kind === "memory" ? FOLDER_MEMORY : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  const url = cloudinary.url(publicId, { resource_type: "raw", secure: true });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      setCache(cacheKey, data);
      return data;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Lists resources of a given kind (for chat/project history sidebar) */
export async function listJson(kind = "chat", maxResults = 100) {
  const cacheKey = `list:${kind}:${maxResults}`;
  const cached = getCached(cacheKey, CACHE_TTL.list);
  if (cached) return cached;

  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : kind === "memory" ? FOLDER_MEMORY : FOLDER_CHATS;
  let allResources = [];
  let nextCursor = undefined;
  let remaining = maxResults;
  do {
    const batch = Math.min(remaining, 500);
    const result = await cloudinary.api.resources({
      type: "upload",
      resource_type: "raw",
      prefix: `${folder}/`,
      max_results: batch,
      next_cursor: nextCursor
    });
    const batchResources = result.resources || [];
    allResources.push(...batchResources);
    remaining -= batchResources.length;
    nextCursor = result.next_cursor;
    if (!nextCursor || remaining <= 0) break;
  } while (allResources.length < maxResults);
  allResources = allResources.slice(0, maxResults);
  setCache(cacheKey, allResources);
  return allResources;
}

export async function deleteJson(id, kind = "chat") {
  const folder =
    kind === "project" ? FOLDER_PROJECTS : kind === "snapshot" ? FOLDER_SNAPSHOTS : kind === "memory" ? FOLDER_MEMORY : FOLDER_CHATS;
  const publicId = `${folder}/${id}`;
  await cloudinary.uploader.destroy(publicId, { resource_type: "raw", type: "upload" });
  invalidateCache(`load:${kind}:${id}`);
  invalidateCache(`list:${kind}`);
}

export { cloudinary };
