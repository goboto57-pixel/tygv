/**
 * SINGLE SOURCE OF TRUTH for "how big is this task" — MAX_LOOPS and
 * max_tokens are derived from ONE classifier here (agentLoop.js and
 * mistralClient.js both import it) so the loop-count budget and the
 * per-completion token cap can never drift apart again like they did
 * before this module existed.
 *
 * Tiers, from cheapest to most expensive:
 *   trivial - a one-clause tweak ("change the button color to red")
 *   fix     - a small, localized fix to something that already exists
 *   simple  - a single page / small static site (landing, one-pager)
 *   general - "make me a site/app" with no size signal either way (default)
 *   big     - explicitly multi-page / enterprise / full-stack / backend+db
 *
 * The classifier combines THREE signals rather than one flat regex pass:
 *   1. explicit size/complexity keywords (RU + EN)
 *   2. structural signals (backend/API/database/auth mentions push a tier up,
 *      since those tasks reliably need more tool round trips than plain
 *      markup even when the wording sounds simple)
 *   3. message shape (very short imperative -> trivial/fix; a long prompt
 *      listing several distinct asks -> bumped up a tier, since multi-part
 *      requests run out of loop budget the most often)
 */

// NOTE: no \b word-boundary anchors here — JS regex `\b` is defined via
// `\w` ([A-Za-z0-9_] only), so it does NOT create a boundary around
// Cyrillic letters (a space -> Cyrillic-letter transition is \W -> \W,
// i.e. no boundary at all). An earlier version of this file used \b on
// mixed RU/EN patterns and it silently made every Cyrillic branch dead,
// collapsing almost everything into the "general" bucket. Plain
// substring/alternation matching (as originally written) is what actually
// works for both scripts.
const TRIVIAL_RE = /(поменяй цвет|измени текст|typo|опечатк|цвет кнопки|change (the )?color|one word|однослов)/i;
const FIX_RE = /(фикс|поправь|исправь|мелкий|мелк(ая|ое) правк|баг(?!ажник)|one.?line|small fix|quick fix|tweak)/i;
const SIMPLE_RE = /(простой сайт|одностраничник|лендинг|landing|визитк|single.?page|one.?pager)/i;
const GENERAL_RE = /(сайт|приложение|app|website|страниц)/i;
const BIG_RE = /(большой|сложный|enterprise|full.?stack|многостраничн|dashboard|дашборд|\bcrm\b|\berp\b|marketplace|маркетплейс)/i;

// Structural signals: presence strongly suggests real multi-file, multi-round
// work regardless of how the request happens to be phrased ("сделай логин"
// sounds small but implies auth/session/db plumbing).
const BACKEND_RE = /(\bapi\b|backend|бэкенд|бекенд|сервер(?!ный ответ)|database|база данных|\bбд\b|auth(entication)?|авториз|аутентиф|payment|оплат|webhook|websocket|очеред|\bqueue\b|migration|миграц)/i;

// Multiple distinct asks in one message ("и ещё сделай…", "также добавь…",
// "and also", numbered/bulleted lists) reliably burn more loop iterations
// than a single request of the same raw length.
const MULTI_PART_RE = /(\n\s*[-*\d]|также добавь|и ещё|и еще|and also|as well as|additionally)/i;

function countWords(text) {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

export function classifyTask(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const words = countWords(text);

  let tier;
  if (BIG_RE.test(text)) tier = "big";
  else if (TRIVIAL_RE.test(text) && words < 12) tier = "trivial";
  else if (FIX_RE.test(text) && text.length < 120) tier = "fix";
  else if (SIMPLE_RE.test(text)) tier = "simple";
  else if (GENERAL_RE.test(text)) tier = "simple"; // plain "make me a site/app" with no other size signal => simple, not the expensive default
  else tier = "general";

  // Structural bump: real backend/auth/db work needs more room even if the
  // wording matched "simple"/"fix" above (e.g. "поправь баг в авторизации").
  if (BACKEND_RE.test(text) && (tier === "trivial" || tier === "fix" || tier === "simple")) {
    tier = tier === "trivial" ? "fix" : "general";
  }

  // Multi-request bump: several distinct asks in one message need more loop
  // budget than a single request of comparable length would.
  if (MULTI_PART_RE.test(text) && (tier === "trivial" || tier === "fix" || tier === "simple")) {
    tier = "general";
  }

  // Very long, detailed briefs (spec-like prompts) rarely fit in the
  // "simple"/"general" budget even without an explicit "big" keyword.
  if (words > 220 && tier !== "big") tier = "big";

  return tier;
}

// Bumped from the original {3,5,6,10,22} / {1200,2000,4000,6000,14000}:
// in practice "general" (a plain "make me an app/site") and "big" tasks were
// hitting stopWithProgress() well before the task was actually done, which
// reads to the user as "не дописывает" — the model was still making real
// progress (writing files, not looping pointlessly) when the hard wall hit.
// Trivial/fix/simple are left as-is; those tiers were rarely the ones
// reported as incomplete.
const LOOP_BUDGET = { trivial: 3, fix: 5, simple: 8, general: 16, big: 34 };
const TOKEN_BUDGET = { trivial: 1200, fix: 2000, simple: 4500, general: 8000, big: 16000 };

export function getMaxLoops(prompt) {
  return LOOP_BUDGET[classifyTask(prompt)];
}

export function getMaxTokens(prompt) {
  return TOKEN_BUDGET[classifyTask(prompt)];
}

// Auto model routing: only used when the caller passes model === "auto" (or
// no model at all) — never overrides an explicit user choice, so this is
// purely additive. Previously every task ran on whatever single model was
// selected in the UI regardless of size: a one-line tweak paid full
// Medium/Large latency+cost, while a real backend/auth task got the same
// budget as a landing page and often just ran out of loops. Cheap/fast
// models for trivial/fix work, the strongest model reserved for tasks that
// actually need multi-step reasoning.
const MODEL_ROUTE = {
  trivial: "ministral-8b-latest",
  fix: "ministral-14b-latest",
  simple: "mistral-medium-latest",
  general: "mistral-medium-latest",
  big: "mistral-large-latest"
};

export function autoRouteModel(prompt) {
  return MODEL_ROUTE[classifyTask(prompt)];
}
