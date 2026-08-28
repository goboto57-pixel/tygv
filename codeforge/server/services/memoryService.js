/**
 * Persistent project memory.
 *
 * Unlike chat history (per-session, per-request) this is a small durable
 * store of decisions/patterns keyed by chatId, that survives across
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

function memoryId(chatId) {
  return `mem-${chatId}`;
}

/**
 * Loads all memory entries for a project. Returns [] if none exist yet or
 * the store is unreachable (memory is a nice-to-have, never a hard
 * dependency for the agent loop to function).
 */
export async function loadMemory(chatId) {
  if (!chatId) return [];
  try {
    const data = await loadJson(memoryId(chatId), "memory");
    return Array.isArray(data?.entries) ? data.entries : [];
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

export async function saveMemory(chatId, { text, category = "note" }) {
  if (!chatId || !text) return { saved: false };
  const trimmedText = String(text).slice(0, MAX_ENTRY_LEN).trim();
  if (!trimmedText) return { saved: false };

  const existing = await loadMemory(chatId);

  // Skip near-duplicates: same category + high word overlap (Jaccard > 0.8)
  // This is more robust than substring matching and avoids false positives
  // like "uses TypeScript" vs "uses TypeScript strict mode".
  const isDuplicate = existing.some(
    (e) => e.category === category && jaccardSimilarity(e.text, trimmedText) > 0.8
  );
  if (isDuplicate) return { saved: false, reason: "duplicate" };

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: trimmedText,
    category,
    createdAt: new Date().toISOString()
  };

  const next = [...existing, entry].slice(-MAX_ENTRIES);
  await saveJson(memoryId(chatId), { entries: next }, "memory");
  return { saved: true, entry };
}

export async function deleteMemoryEntry(chatId, entryId) {
  const existing = await loadMemory(chatId);
  const next = existing.filter((e) => e.id !== entryId);
  await saveJson(memoryId(chatId), { entries: next }, "memory");
  return { deleted: existing.length !== next.length };
}

export async function clearMemory(chatId) {
  await saveJson(memoryId(chatId), { entries: [] }, "memory");
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
    byCategory[e.category] = byCategory[e.category] || [];
    byCategory[e.category].push(e.text);
  }
  const sections = Object.entries(byCategory).map(
    ([cat, texts]) => `${cat.toUpperCase()}:\n${texts.map((t) => `- ${t}`).join("\n")}`
  );
  return `\n\nPROJECT MEMORY (durable notes from earlier sessions, still relevant unless contradicted by current files):\n${sections.join("\n\n")}`;
}
