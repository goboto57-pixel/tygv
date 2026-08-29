/**
 * SINGLE SOURCE OF TRUTH for "how big is this task" — MAX_LOOPS and
 * max_tokens were previously classified by THREE separate, hand-copied
 * regex blocks (agentLoop.js legacy loop, agentLoop.js Conversations path,
 * mistralClient.js) that had silently drifted apart. The worst mismatch:
 * mistralClient's regex only recognized "landing"/"лендинг" for the cheap
 * tier, while agentLoop's loop-count regex also matched plain "сайт" /
 * "app" / "website" — so an ordinary "сделай сайт для кофейни" request got
 * the CHEAP loop budget (6) in one place but the EXPENSIVE default token
 * cap (8000, same as "big") in another. That mismatch — not the number of
 * tool round trips — is what actually produces multi-minute simple turns:
 * up to 12 loop iterations (general-bucket default), each capable of
 * generating up to 8000 tokens.
 *
 * Tiers, from cheapest to most expensive:
 *   fix     - tiny one-line fix/tweak to something that already exists
 *   simple  - a single page / small static site (landing, one-pager, small fix set)
 *   general - "make me a site/app" with no size signal either way (default)
 *   big     - explicitly multi-page / enterprise / full-stack
 */
const FIX_RE = /(фикс|поправь|исправь|мелкий|one.?line|small fix)/i;
const SIMPLE_RE = /(простой сайт|одностраничник|лендинг|landing|визитк|single.?page)/i;
const GENERAL_RE = /(сайт|приложение|app|website|страниц)/i;
const BIG_RE = /(большой|сложный|enterprise|full.?stack|многостраничн)/i;

export function classifyTask(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  if (FIX_RE.test(text) && text.length < 120) return "fix";
  if (SIMPLE_RE.test(text)) return "simple";
  if (BIG_RE.test(text)) return "big";
  if (GENERAL_RE.test(text)) return "simple"; // plain "make me a site/app" with no size signal => treat as simple, not the expensive default
  return "general";
}

const LOOP_BUDGET = { fix: 5, simple: 6, general: 10, big: 20 };
const TOKEN_BUDGET = { fix: 2000, simple: 4000, general: 6000, big: 12000 };

export function getMaxLoops(prompt) {
  return LOOP_BUDGET[classifyTask(prompt)];
}

export function getMaxTokens(prompt) {
  return TOKEN_BUDGET[classifyTask(prompt)];
}
