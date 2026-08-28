/**
 * Persistent project memory.
 *
 * Unlike chat history (per-session, per-request) this is a small durable
 * store of decisions/patterns keyed by a stable workspace scope, that survives across
 * sessions and gets re-injected into the system prompt on every turn. The
 * agent can write to it explicitly (save_memory tool) and it's also
 * consulted automatically at the start of a loop (recall happens in
 * agentLoop.js, not here — this module only handles storage).
 *
 * Deliberately NOT the same thing as the embeddings-based semantic_search
 * in projectFS.js: that indexes the current file tree contents on the fly
 * per-request, this stores explicit, curated notes the agent decided were
 * worth keeping ("we use zustand not redux here", "the API expects snake_case",
 * "don't touch legacy/ - it's frozen for a migration").
 */
import { saveJson, loadJson } from "./cloudinaryService.js";

const MAX_ENTRIES = 60;
const MAX_ENTRY_LEN = 400;

// In-memory cache so the agent loop doesn't pay a Cloudinary round-trip on
// every turn just to recall project memory. Invalidated whenever memory is
// written/deleted/cleared for that scope. TTL as a safety net against drift.
const memoryCache = new Map(); // scopeId -> { entries, ts }
const MEMORY_CACHE_TTL = 5 * 60 * 1000;

function memoryId(scopeId) {
  const safe = String(scopeId || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return `mem-${safe}`;
}

function cachePut(scopeId, entries) {
  memoryCache.set(scopeId, { entries, ts: Date.now() });
}
function cacheGet(scopeId) {
  const hit = memoryCache.get(scopeId);
  if (!hit) return null;
  if (Date.now() - hit.ts > MEMORY_CACHE_TTL) { memoryCache.delete(scopeId); return null; }
  return hit.entries;
}

/**
 * Loads all memory entries for the current workspace. Returns [] if none exist yet or
 * the store is unreachable (memory is a nice-to-have, never a hard
 * dependency for the agent loop to function). Cached in-memory for speed.
 */
export async function loadMemory(scopeId) {
  if (!scopeId) return [];
  const cached = cacheGet(scopeId);
  if (cached) return cached;
  try {
    const data = await loadJson(memoryId(scopeId), "memory");
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    cachePut(scopeId, entries);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Appends a new memory entry (deduplicating near-identical notes) and
 * trims to MAX_ENTRIES, dropping the oldest first. Each entry is tagged
 * with a category so the system-prompt renderer can group them.
 */
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

const memoryLocks = new Map();
async function withMemoryLock(scopeId, fn) {
  const prev = memoryLocks.get(scopeId) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  memoryLocks.set(scopeId, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); }
}

function sanitizeForPrompt(text) {
  // Prevent stored prompt injection: neutralize common injection patterns
  return String(text)
    .replace(/\[SYSTEM\]/gi, "[SYS]")
    .replace(/ignore previous/gi, "ignore-previous")
    .replace(/<\/?system>/gi, "")
    .slice(0, MAX_ENTRY_LEN);
}

export async function saveMemory(scopeId, { text, category = "note" }) {
  if (!scopeId || !text) return { saved: false };
  const sanitized = sanitizeForPrompt(text);
  const trimmedText = sanitized.trim();
  if (!trimmedText) return { saved: false };
  // Validate category
  const safeCategory = String(category).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30) || "note";

  return withMemoryLock(scopeId, async () => {
    const existing = await loadMemory(scopeId);

    // Skip near-duplicates: same category + high word overlap (Jaccard > 0.8)
    const isDuplicate = existing.some(
      (e) => e.category === safeCategory && jaccardSimilarity(e.text, trimmedText) > 0.8
    );
    if (isDuplicate) return { saved: false, reason: "duplicate" };

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: trimmedText,
      category: safeCategory,
      createdAt: new Date().toISOString()
    };

    const next = [...existing, entry].slice(-MAX_ENTRIES);
    await saveJson(memoryId(scopeId), { entries: next }, "memory");
    cachePut(scopeId, next);
    return { saved: true, entry };
  });
}

export async function deleteMemoryEntry(scopeId, entryId) {
  const existing = await loadMemory(scopeId);
  const next = existing.filter((e) => e.id !== entryId);
  await saveJson(memoryId(scopeId), { entries: next }, "memory");
  cachePut(scopeId, next);
  return { deleted: existing.length !== next.length };
}

export async function clearMemory(scopeId) {
  await saveJson(memoryId(scopeId), { entries: [] }, "memory");
  cachePut(scopeId, []);
}

/**
 * Renders memory entries into a compact block for the system prompt.
 * Grouped by category so related notes read together instead of as one
 * flat dump. Kept short by design — this is meant to be a handful of
 * durable facts, not a second copy of the chat log.
 */
export function renderMemoryForPrompt(entries) {
  if (!entries || entries.length === 0) return "";
  const byCategory = {};
  for (const e of entries) {
    // sanitize on render as defense in depth
    const safeText = String(e.text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").slice(0, MAX_ENTRY_LEN);
    const safeCat = String(e.category).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
    byCategory[safeCat] = byCategory[safeCat] || [];
    byCategory[safeCat].push(safeText);
  }
  const sections = Object.entries(byCategory).map(
    ([cat, texts]) => `${cat.toUpperCase()}:\n${texts.map((t) => `- ${t}`).join("\n")}`
  );
  return `\n\nPROJECT MEMORY (durable notes from earlier sessions, still relevant unless contradicted by current files):\n${sections.join("\n\n")}`;
}
