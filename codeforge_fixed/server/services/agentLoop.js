import { streamMistralChat, VISION_MODEL, IMAGE_GENERATION_TOOL } from "./mistralClient.js";
import { streamGeminiChat } from "./geminiClient.js";
import { streamCloudflareChat, isCloudflareModel } from "./cloudflareClient.js";
import { toolDefinitions } from "./toolDefinitions.js";
import { executeTool, createFSFromFiles, fsToArray } from "./projectFS.js";
import { runCouncil, delegateSubagentTool, runSubagent } from "./orchestrator.js";
import { loadMemory, saveMemory, renderMemoryForPrompt } from "./memoryService.js";
import { splitToolCalls } from "./toolExecution.js";
import { createBudgetTracker } from "./budgetTracker.js";
import { computeSessionMetrics } from "./sessionMetrics.js";
import { runMistralWebSearch } from "./webSearchClient.js";
import { buildSingleShotSystemPrompt, parseSingleShotResponse, isProjectSmallEnoughForSingleShot } from "./singleShotGenerator.js";
import { getMaxLoops, getMaxTokens, classifyTask, autoRouteModel } from "./taskComplexity.js";
import { ensureAgent, startConversation, appendConversation, extractFunctionCalls, extractText } from "./mistralAgentClient.js";

// chatId -> { conversationId, agentKey } — lets a chat's turns re-use the
// same server-side Mistral conversation (see runConversationsPath below) so
// only the NEW turn is sent, instead of replaying the whole history like
// the old /v1/chat/completions loop did. Process-memory only: a server
// restart just starts a fresh conversation on the next turn (Mistral still
// has the old one, we just stop referencing it).
const conversationCache = new Map();

// Emits an error event, forwarding full server-side diagnostic detail
// (HTTP status, request/response headers+bodies, timing — see
// mistralAgentClient.js postJson) when the error carries one, so the client
// can show/copy the real cause instead of a generic message.
function emitError(onEvent, message, err) {
  onEvent({ type: "error", message, detail: err?.detail || null, stack: err?.stack || null });
}

const SYSTEM_PROMPT = `You are CodeForge — fast, token-efficient coding agent (Mistral). Build working software quickly.

Rules:
1. For complex/multi-part tasks call make_plan FIRST; trivial 1-3 file sites/fixes need NO plan — just write the files.
2. Prefer static HTML/CSS/JS (no build). Only use framework if user asks.
3. When done, summarize and STOP — no more tool calls. Never run dev server; use run_command if needed.
4. Use file tools: list_directory_tree, read_file(s), write_file, edit_file, delete/rename, find_files, search_code, grep, lint_file(s), web_fetch.
4a. Before read_file(s) on a file you suspect is large (>150 lines) and you only need to locate something in it, call outline_file first — it returns function/class/component signatures with line numbers for a fraction of the tokens a full read costs. Only fall back to read_file(s) once you know which part you actually need to see or edit.
4b. Creating/overwriting more than one file in the same turn? Use write_files with ALL of them in ONE call — never one write_file per file. Same for reads (read_files) and lint (lint_files). Every extra tool call costs a full network round trip AND real generation time — this is not a UI/perceived-latency thing, it is actual minutes and actual tokens.
4c. Editing several separate spots in the SAME file in one turn? Use apply_patch with all the edits in one call instead of several edit_file calls on that path.
5. Return files via tools only — never paste code in chat.
6. Read before edit if unsure; use list_directory_tree for structure.
7. Briefly explain reasoning (shown as thought); code only in tools.
8. edit_file for small patches, write_file for new/full rewrites.
9. grep for regex, search_code for plain text, semantic_search for concepts, web_fetch for docs, web_search for current info from the live web (has sources).
10. Verification is proportional to risk, not automatic. For a simple static site/landing page (1-4 files, no backend): ONE check_preview call after write_files is enough — do NOT also lint_file/lint_files each one individually unless check_preview reports an actual problem, and NEVER call run_tests unless the project already has an existing test setup (package.json test script, existing *.test.* files) — there is nothing to test on a static page and trying will just waste a turn discovering that. For anything with real logic (backend, non-trivial JS, data processing): read back the changed file(s) in ONE read_files call, lint_files once, run_tests only if a test setup exists. Never claim failing tests pass.
11. Clean, production code — no over-engineering or extra features.
12. End with concise summary + run/preview steps.
13. Be direct, no fluff.
14. Save durable facts with save_memory once (deduplicate).

Economy: be concise, avoid redundant reads/lints, prefer batch ops, stop as soon as the result is good enough — don't keep re-verifying something that already checked out. A simple landing/site must finish in ≤4 tool calls total (write_files, optionally check_preview, done). Every additional tool call beyond what's strictly needed costs real minutes and real tokens, not just perceived latency.`;

/**
 * Runs the full agent loop for one user turn, streaming events via onEvent.
 * onEvent receives: { type: 'reasoning'|'tool_call'|'tool_result'|'plan'|'file'|'final'|'usage'|
 *                      'prompt_enhanced'|'council'|'subagent_start'|'subagent_done'|
 *                      'diff_pending'|'budget_warning'|'rollback'|'session_report'|'memory_saved', ...payload }
 *
 * mode:
 *   - "single"  : one model runs the whole agent loop (default, model = settings.model)
 *   - "council" : Gemini 3.7 Flash + Mistral Large independently analyze the task and Mistral Large
 *                 merges both views into one plan, which then seeds a normal Mistral Large-driven loop
 *   - "collab"  : Mistral Large chairs the task and can delegate focused sub-tasks to Devstral
 *                 subagents via the delegate_to_subagent tool, instead of doing everything itself
 *
 * options:
 *   - requireApproval : if true, every write_file/edit_file/delete_file waits for the caller to
 *                        approve/reject via a resolveApproval-style callback before being applied.
 *                        See the "diff review" section below for how this is wired without
 *                        blocking the whole HTTP response indefinitely.
 *   - onApprovalNeeded : async ({ path, kind, before, after }) => boolean. Required if requireApproval.
 *                        Resolves true to apply the change, false to skip it (tool call still
 *                        returns a result to the model either way, so it can react to a rejection).
 *   - autoRollbackOnTestFailure : if true, and the loop's own run_tests call ends with failing
 *                        tests that are never fixed by the end of the turn, the file tree is
 *                        reverted to what it was at the START of the turn.
 */
export async function runAgentLoop({
  history,
  files,
  model,
  mode = "single",
  // toolMode: "code" (default agent tool loop) | "web_search" | "web_search_premium" | "image"
  // Mirrors the "Code / Search / Premium Search / Image" capability toggle in
  // the official Mistral console playground.
  toolMode = "code",
  reasoningEffort = "none",
  circuitBreaker = true,
  budgetPause = false,
  enhance = true,
  images,
  chatId,
  memoryKey = chatId,
  requireApproval = false,
  onApprovalNeeded,
  requirePlanApproval = false,
  onPlanApproveNeeded,
  autoRollbackOnTestFailure = true,
  budgetLimits,
  onEvent,
  signal
}) {
  const fsMap = createFSFromFiles(files);
  // Snapshot of the file tree exactly as the turn started, kept purely
  // in-memory for the lifetime of this call — this is what auto-rollback
  // reverts to if tests end up failing and are never fixed. Independent of
  // the user-facing "Snapshots" feature (which is explicit/manual and
  // persisted); this one is silent and automatic.
  const preTurnFiles = new Map(fsMap);

  const budget = createBudgetTracker(budgetLimits);
  const toolTimers = new Map(); // name -> startedAt (ms)

  // --- Diagnostics: where does the wall-clock time in a turn actually go? ---
  // Every previous round of tuning was a guess. This records real numbers
  // so the next bottleneck can be found from evidence instead of theory.
  // Zero effect on behavior — pure bookkeeping, printed once at the end of
  // the turn via finalizeTurn(). Declared this early so every code path
  // below (single-shot, Conversations API, legacy loop) can use it.
  const perf = { turnStart: Date.now(), modelMs: 0, rateLimitWaitMs: 0, toolMs: 0, modelCalls: 0, rateLimitHits: 0, toolCalls: 0 };
  const timeModelCall = async (fn) => {
    const t0 = Date.now();
    try { return await fn(); } finally { perf.modelMs += Date.now() - t0; perf.modelCalls++; }
  };
  const timeToolCall = async (fn) => {
    const t0 = Date.now();
    try { return await fn(); } finally { perf.toolMs += Date.now() - t0; perf.toolCalls++; }
  };
  const logPerfSummary = () => {
    const totalMs = Date.now() - perf.turnStart;
    const otherMs = Math.max(0, totalMs - perf.modelMs - perf.toolMs - perf.rateLimitWaitMs);
    console.log(
      `[perf] turn=${totalMs}ms | model=${perf.modelMs}ms (${perf.modelCalls} calls) | ` +
      `rate_limit_wait=${perf.rateLimitWaitMs}ms (${perf.rateLimitHits} hits) | ` +
      `tools=${perf.toolMs}ms (${perf.toolCalls} calls) | other/overhead=${otherMs}ms`
    );
    // Same breakdown, sent to the client so it shows up in the UI instead
    // of only the server console — this is what the "perf" panel reads.
    onEvent({
      type: "perf",
      totalMs,
      modelMs: perf.modelMs,
      modelCalls: perf.modelCalls,
      rateLimitWaitMs: perf.rateLimitWaitMs,
      rateLimitHits: perf.rateLimitHits,
      toolMs: perf.toolMs,
      toolCalls: perf.toolCalls,
      otherMs
    });
  };

  // --- Step -1: load durable project memory, if any, and fold it into the system prompt ---
  const memoryEntries = await loadMemory(memoryKey);
  const memoryBlock = renderMemoryForPrompt(memoryEntries);

  // --- Step -0.5: sanitize incoming history against Mistral's hard rule that an
  // assistant message must have non-empty content OR tool_calls, never neither.
  // Client-side chat state (or an older cached chat) can end up with an assistant
  // turn that was cut short (error, abort, hit MAX_LOOPS) leaving content: "".
  // If that message is ever replayed back to us as part of `history`, Mistral
  // rejects the ENTIRE request with a 400 before the new turn even starts. We
  // only get raw {role, content} pairs from the client (no tool_calls), so any
  // assistant message with empty/missing content here is unrecoverable noise —
  // drop it rather than let it poison every future turn in this chat.
  history = (history || []).filter((m) => !(m.role === "assistant" && !m.content));

  // Step 0 (removed): this used to run every user message through a separate
  // Mistral call ("promptEnhancer") to sharpen vague UI/design requests before
  // the real agent loop started. Removed entirely per user request — its
  // trigger regex matched almost any Russian message (it included "сделай"/
  // "добавь"), so it fired on nearly every turn, and being a full blocking
  // `await` with its own 6-attempt retry/backoff, it could itself add minutes
  // of latency before the agent even started — independent of which agent
  // model was selected, which is exactly why switching models didn't help.
  const workingHistory = history;
  const rawLastPrompt = history[history.length - 1]?.content || "";

  // --- Web Search / Premium Search modes ---
  // These two built-in Mistral connectors only work through the
  // Conversations API (/v1/conversations), not /v1/chat/completions, so they
  // can't just be added to the normal file-editing tool loop below (Mistral
  // silently ignores/rejects them there). Handle them as a separate,
  // single-shot path: ask the question, stream nothing (Conversations API
  // call here is non-streaming), emit the answer + sources, done. The
  // project's files are left untouched.
  if (toolMode === "web_search" || toolMode === "web_search_premium") {
    const query = typeof rawLastPrompt === "string" ? rawLastPrompt : "";
    onEvent({ type: "status", text: toolMode === "web_search_premium" ? "Ищу в интернете (premium)…" : "Ищу в интернете…" });
    try {
      const { text, citations } = await runMistralWebSearch({
        query,
        premium: toolMode === "web_search_premium",
        model: model && model !== "codestral-latest" ? model : "mistral-medium-latest"
      });
      const finalText = citations.length
        ? `${text}\n\nИсточники:\n${citations.map((c) => `- ${c.title || c.url}: ${c.url}`).join("\n")}`
        : text;
      const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...workingHistory, { role: "assistant", content: finalText || "(пустой ответ)" }];
      onEvent({ type: "final", text: finalText || "(пустой ответ)" });
      onEvent({ type: "usage", usage: { prompt_tokens: 0, completion_tokens: 0 } });
      onEvent({ type: "files", files: fsToArray(fsMap) });
      const messagesToPersist = messages.filter((m) => m.role !== "system");
      return { messages: messagesToPersist, files: fsToArray(fsMap), usage: { prompt_tokens: 0, completion_tokens: 0 }, rolledBack: false };
    } catch (err) {
      onEvent({ type: "error", message: `Web search failed: ${err.message}` });
      const messages = [...workingHistory];
      return { messages, files: fsToArray(fsMap), usage: { prompt_tokens: 0, completion_tokens: 0 }, rolledBack: false };
    }
  }

  // "auto" (or no model at all) hands model choice to the task classifier
  // instead of always paying for whatever model happens to be selected in
  // the UI — a trivial tweak no longer runs on the same model/budget as a
  // real backend task. An explicit model choice from the caller is never
  // touched.
  let effectiveModel = model && model !== "auto" ? model : autoRouteModel(rawLastPrompt);
  let extraTools = [];
  let leadingNote = "";

  // --- Step 1: mode-specific setup ---
  if (mode === "council" && circuitBreaker !== false) {
    onEvent({ type: "council", status: "thinking" });
    const lastUserText = workingHistory[workingHistory.length - 1]?.content || "";
    const projectSummary = fsToArray(fsMap)
      .map((f) => f.path)
      .slice(0, 60)
      .join(", ");
    try {
      const { geminiText, mistralText, decision } = await runCouncil({ taskText: lastUserText, projectSummary });
      onEvent({ type: "council", status: "done", geminiText, mistralText, decision });
      leadingNote = `\n\nSTRATEGY NOTE (agreed by council review before you start): ${decision}`;
      try { await saveMemory(memoryKey, { text: decision.slice(0, 400), category: "decision" }); } catch {}
    } catch (err) {
      onEvent({ type: "council", status: "error", message: err.message });
    }
    effectiveModel = "mistral-large-latest";
  } else if (mode === "collab") {
    effectiveModel = "mistral-large-latest";
    extraTools = [delegateSubagentTool];
    leadingNote =
      "\n\nYou are chairing this task. For any sub-part that is well-scoped and mechanical (a component, a route, a config file), prefer calling delegate_to_subagent instead of implementing it yourself, then review/integrate the result. Keep architecture decisions and final integration to yourself.";
  }

  const isGemini = /^gemini-3\./.test(effectiveModel);
  const isCloudflare = isCloudflareModel(effectiveModel);
  const chatFn = isCloudflare ? streamCloudflareChat : isGemini ? streamGeminiChat : streamMistralChat;

  const messages = [{ role: "system", content: SYSTEM_PROMPT + leadingNote + memoryBlock }, ...workingHistory];

  // --- Vision: design-reference screenshots dropped into the chat ---
  // Turns this into a Mistral multimodal message (text + image_url parts) and
  // forces the vision-capable Pixtral model for this turn only, so the agent
  // can actually "see" the reference while still using its normal file tools.
  if (images && images.length > 0 && !isGemini && !isCloudflare) {
    effectiveModel = VISION_MODEL;
    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    if (lastMsg && lastMsg.role === "user") {
      messages[lastIdx] = {
        ...lastMsg,
        content: [
          { type: "text", text: lastMsg.content || "See the attached image(s) for design/context reference." },
          ...images.slice(0, 4).map((img) => ({ type: "image_url", image_url: img.dataUrl }))
        ]
      };
    }
    onEvent({ type: "vision", count: Math.min(images.length, 4), model: VISION_MODEL });
  }

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let loopCount = 0;
  // Economy: adaptive loops — see taskComplexity.js for the single shared
  // classifier (this used to be its own drifted-apart regex copy).
  const taskTier = classifyTask(rawLastPrompt);
  const MAX_LOOPS_BASE = getMaxLoops(rawLastPrompt);
  // MAX_LOOPS is now mutable: see the "grace" extension below. Fixing it as
  // a hard wall was the actual cause of turns visibly still making progress
  // (files being written each iteration) getting cut off mid-task with
  // "⚠️ Ход прерван" — which reads as the agent being dumb/giving up, when
  // it was really just an under-estimated budget from a regex guess.
  let MAX_LOOPS = MAX_LOOPS_BASE;
  const MAX_LOOPS_HARD_CAP = Math.ceil(MAX_LOOPS_BASE * 1.5) + 2;
  // Wall-clock safety net, independent of loop count: even when every
  // individual model/tool call succeeds within its own retry budget, a turn
  // that keeps looping can still take several minutes — this (not any
  // single slow call) is what a user actually experiences as "slow". Tiered
  // by task size so a trivial tweak can't quietly run for minutes, while a
  // genuinely big task still gets real room.
  const TURN_TIME_BUDGET_MS =
    { trivial: 60_000, fix: 90_000, simple: 150_000, general: 240_000, big: 420_000 }[taskTier] || 180_000;
  const trimForEconomy = (msgs) => {
    if (msgs.length <= 16) return msgs;
    const TARGET = 14;
    let start = Math.max(1, msgs.length - TARGET);
    // A "tool" message MUST be immediately preceded by the assistant
    // message that issued its tool_calls — Mistral rejects the request
    // outright otherwise (or, worse, silently produces a confused
    // response from a context missing half a tool-call/result pair). A
    // flat slice(-12) could land the cut right in the middle of such a
    // pair on any turn longer than 16 messages; walk back to the start of
    // that assistant/tool group instead of ever slicing through one.
    while (start > 1 && msgs[start].role === "tool") start--;
    return [msgs[0], ...msgs.slice(start)];
  };
  // For simple tasks drop heavy tools to save tokens/round-trips
  const isSimpleEconomy = /(простой сайт|одностраничник|лендинг|simple site|landing page|простой)/i.test(rawLastPrompt);
  // Only offer run_tests if the project actually HAS something to test —
  // package.json with a test script, or an existing *.test.*/*.spec.*
  // file. Otherwise the agent calls run_tests anyway "to verify", gets a
  // failure/empty result, and burns a whole extra turn discovering there
  // was nothing to run — a real, frequent source of wasted loop iterations
  // on plain static sites that never asked for tests.
  const hasTestSetup = (() => {
    for (const [path, content] of fsMap.entries()) {
      if (/\.(test|spec)\.[jt]sx?$/i.test(path) || /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(path)) return true;
      if (/(^|\/)package\.json$/i.test(path)) {
        try { if (JSON.parse(content)?.scripts?.test) return true; } catch {}
      }
    }
    return false;
  })();
  // The full toolDefinitions list is ~2000 tokens of JSON schema, and it is
  // resent to the model on EVERY single loop iteration (function-calling
  // tools are part of the prompt, not a one-time cost) — for a 10-16
  // iteration turn that's 20,000-32,000 tokens spent on schemas for tools
  // that were never called, before a single line of actual work happens.
  // Most requests ("trivial"/"fix"/"simple" tiers — a tweak, a small fix, a
  // one-pager) never touch the rarer/specialist tools below, so only pay
  // for them on tiers where they're plausibly relevant ("general"/"big").
  const RARE_TOOLS = new Set([
    "semantic_search", "web_fetch", "web_search", "duplicate_file",
    "create_folder", "get_project_stats", "todo_scan", "format_code",
    "analyze_bundle", "extract_colors", "generate_tests", "refactor"
  ]);
  const isRoomyTier = (taskTier === "general" || taskTier === "big") && !isCloudflare;
  const baseTools = toolDefinitions.filter((t) => {
    const name = t.function.name;
    if (!hasTestSetup && name === "run_tests") return false;
    if (isSimpleEconomy && ["semantic_search", "delegate_to_subagent"].includes(name)) return false;
    if (!isRoomyTier && RARE_TOOLS.has(name)) return false;
    return true;
  });
  // Image mode: add Mistral's built-in image_generation connector (works in
  // Chat Completions, unlike web_search/code_interpreter) on top of the
  // normal file tools, so the agent can generate an image AND drop it into
  // the project (e.g. as an asset referenced by the site it's building).
  const builtinTools = toolMode === "image" ? [IMAGE_GENERATION_TOOL] : [];
  const activeTools = [...baseTools, ...extraTools];
  let repeatedTurnSignature = "";
  let repeatedTurnCount = 0;
  // Keep a bounded loop so an agent cannot spend minutes repeating the same failed tool call.
  // Larger jobs should use batch reads/edits or a follow-up turn rather than an unbounded loop.

  // Tracked across the whole turn for the end-of-session metrics report and
  // for auto-rollback decisions.
  const changedPaths = [];
  const testRuns = [];
  let lastTestRunFailed = false;
  // Used by the loop-cap "grace" check below (both the Conversations-API
  // loop and the legacy loop share this): how many files had changed the
  // last time we checked whether to extend MAX_LOOPS.
  let changedPathsAtLastGraceCheck = 0;
  // Shared by both loop implementations: called once per iteration, right
  // after loopCount/convLoops is incremented. Returns a stopWithProgress()
  // result if the turn must end now (time budget blown), otherwise null —
  // and extends MAX_LOOPS in place if the agent is genuinely still making
  // progress right as it hits the cap, instead of cutting it off.
  const checkTimeAndGrace = async (currentLoopCount) => {
    if (Date.now() - perf.turnStart > TURN_TIME_BUDGET_MS) {
      return await stopWithProgress(`превышен лимит времени на ход (${Math.round(TURN_TIME_BUDGET_MS / 1000)}с)`);
    }
    if (currentLoopCount === MAX_LOOPS && MAX_LOOPS < MAX_LOOPS_HARD_CAP && changedPaths.length > changedPathsAtLastGraceCheck) {
      MAX_LOOPS = Math.min(MAX_LOOPS_HARD_CAP, MAX_LOOPS + Math.max(2, Math.ceil(MAX_LOOPS_BASE * 0.3)));
      onEvent({ type: "status", text: `Продолжаю — виден реальный прогресс, продлеваю лимит шагов до ${MAX_LOOPS}.` });
    }
    changedPathsAtLastGraceCheck = changedPaths.length;
    return null;
  };
  // Number of plan steps the agent has visibly completed, used to check off
  // the plan card in the UI as work progresses.
  let planStepDone = 0;
  // Most recent make_plan payload, if any — kept so an early exit (budget/
  // loop limit hit) can restate it in the hand-off summary below instead of
  // being lost.
  let lastPlan = null;

  // Builds a concrete, model-readable status report for any turn that ends
  // WITHOUT a normal "I'm done" answer (hit MAX_LOOPS, hit a hard budget,
  // rate-limited out, or stuck repeating itself). This is pushed as the
  // assistant's actual message content — never leave content empty here.
  //
  // Why this matters: the client only ever resends {role, content} text
  // pairs as history on the NEXT turn (no tool-call trace crosses the
  // network — see ChatContext.jsx). It also HARD-DROPS any assistant
  // message whose content is empty before sending, since Mistral 400s on
  // {role:"assistant", content:""} with no tool_calls. So an early exit
  // that only emits an `error` event and never pushes a real assistant
  // message is invisible on the next turn: the whole turn — everything the
  // agent figured out and did — evaporates from the conversation the
  // instant the user says "продолжи", even though the files it wrote are
  // still there. This function is what makes "продолжи" actually continue
  // instead of restarting the agent's reasoning from zero.
  function buildProgressNote(reason) {
    const lines = [`⚠️ Ход прерван: ${reason}`];
    const files = [...new Set(changedPaths)];
    if (files.length) {
      lines.push(`\nИзменённые/созданные файлы (${files.length}): ${files.slice(0, 25).join(", ")}${files.length > 25 ? "…" : ""}`);
    } else {
      lines.push(`\nФайлы в этом ходе ещё не менялись.`);
    }
    if (lastPlan) {
      const steps = Array.isArray(lastPlan.steps) ? lastPlan.steps : Array.isArray(lastPlan) ? lastPlan : null;
      if (steps && steps.length) {
        lines.push(`\nПлан (шаг ${Math.min(planStepDone, steps.length)}/${steps.length} отмечен как сделанный):`);
        steps.forEach((s, i) => {
          const label = typeof s === "string" ? s : s?.title || s?.step || JSON.stringify(s);
          lines.push(`${i < planStepDone ? "✅" : "⏳"} ${i + 1}. ${label}`);
        });
      }
    }
    if (testRuns.length) {
      const last = testRuns[testRuns.length - 1];
      lines.push(`\nПоследний прогон тестов: ${last?.ok ? "успех" : "провал"}.`);
    }
    lines.push(`\nПродолжая этот чат дальше, не начинай заново — опирайся на текущее дерево файлов и план выше, доделай оставшиеся пункты.`);
    return lines.join("\n");
  }

  // Shared exit path for every place the loop can end (final answer, hit
  // MAX_LOOPS, or an abort). Applies auto-rollback and emits the session
  // report exactly once, so those two features can't be forgotten if a new
  // early-return is added here later.
  async function finalizeTurn() {
    let rolledBack = false;
    if (autoRollbackOnTestFailure && lastTestRunFailed) {
      onEvent({
        type: "rollback",
        reason: "Tests were still failing at the end of the turn — reverting file changes made this turn."
      });
      fsMap.clear();
      for (const [path, content] of preTurnFiles) fsMap.set(path, content);
      rolledBack = true;
    }

    try {
      const metrics = await computeSessionMetrics({
        fsMap,
        changedPaths: rolledBack ? [] : changedPaths,
        testRuns
      });
      onEvent({ type: "session_report", metrics, rolledBack });
    } catch {
      // Metrics are a nice-to-have; never let a computation bug break the turn.
    }

    onEvent({ type: "usage", usage: totalUsage });
    onEvent({ type: "files", files: fsToArray(fsMap) });
    if (typeof logPerfSummary === "function") logPerfSummary();
    // Strip system message before persisting - don't store system prompt in DB
    const messagesToPersist = messages.filter((m) => m.role !== "system");
    return { messages: messagesToPersist, files: fsToArray(fsMap), usage: totalUsage, rolledBack };
  }

  // Every early-exit branch (MAX_LOOPS, hard budget, rate-limit exhausted,
  // stuck-repeating) MUST go through this instead of calling finalizeTurn()
  // directly with only an `error` event, or the turn silently loses all its
  // content on the next message — see buildProgressNote() above for why.
  async function stopWithProgress(reason) {
    const note = buildProgressNote(reason);
    messages.push({ role: "assistant", content: note });
    onEvent({ type: "final", text: note });
    return await finalizeTurn();
  }

  // helper for rate-limit detection and backoff (used by both single-shot
  // and the legacy loop below)
  const isRateLimit = (err) => {
    const msg = String(err?.message || "").toLowerCase();
    return err?.status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- Single-shot path: no tools at all, whole task in one model call ---
  // See singleShotGenerator.js for the rationale. Originally only covered
  // brand-new/empty projects; now also covers EDITS to a small/medium
  // existing project, which is the far more common case and where the
  // tool loop (read_file -> write_file -> check_preview, one full model
  // round trip each) was actually costing the minutes. For an edit, every
  // current file is inlined into the prompt up front so the model never
  // needs to call read_file, and it answers with only the files that
  // changed — no write_file/edit_file tool calls either.
  const canUseSingleShot =
    mode === "single" &&
    toolMode === "code" &&
    !requireApproval &&
    !requirePlanApproval &&
    !(images && images.length > 0) &&
    isProjectSmallEnoughForSingleShot(fsMap);
  const isSingleShotEdit = canUseSingleShot && fsMap.size > 0;

  // Diagnostics: previously, when single-shot was skipped or fell back, the
  // only visible symptom was "it's slow" — no way to tell whether it never
  // even attempted single-shot, or attempted and failed to parse. Surface
  // the reason explicitly so this doesn't have to be guessed again.
  if (!canUseSingleShot) {
    const reasons = [];
    if (mode !== "single") reasons.push(`mode="${mode}" (нужен "single")`);
    if (toolMode !== "code") reasons.push(`toolMode="${toolMode}" (нужен "code")`);
    if (requireApproval) reasons.push("requireApproval=true");
    if (requirePlanApproval) reasons.push("requirePlanApproval=true");
    if (images && images.length > 0) reasons.push("есть прикреплённые изображения");
    if (!isProjectSmallEnoughForSingleShot(fsMap)) reasons.push(`проект слишком большой для single-shot (${fsMap.size} файлов)`);
    onEvent({ type: "status", text: `Single-shot пропущен: ${reasons.join(", ")}. Иду обычным циклом с тулами.` });
  }

  async function runSingleShotPath() {
    onEvent({ type: "status", text: isSingleShotEdit ? "Вношу правки одним запросом…" : "Генерирую проект одним запросом…" });
    const existingFiles = isSingleShotEdit ? [...fsMap.entries()] : null;
    const singleShotMessages = [
      { role: "system", content: buildSingleShotSystemPrompt(SYSTEM_PROMPT + leadingNote + memoryBlock, { existingFiles }) },
      ...workingHistory
    ];

    // Single-shot writes the WHOLE deliverable in one completion, so it
    // needs a much bigger cap than a single step of the old tool loop
    // (that classifier-based budget is what silently truncated single-shot
    // responses before, causing a fallback to the slow loop — see
    // mistralClient.js). Creation needs more headroom than an edit, since
    // an edit only re-outputs the files that actually changed.
    let singleShotMaxTokens = isSingleShotEdit ? 16000 : 20000;
    // Set once we've already paid for one truncated attempt and bumped the
    // cap for a retry — see the truncation branch below. Prevents an
    // infinite bump loop; after this, a second truncation gives up on
    // single-shot for real instead of paying for a third full completion.
    let budgetAlreadyBumped = false;

    let text = "";
    let result;
    let files = [], deletions = [], rejected = [], summary = "";

    // Outer loop: at most ONE cheap retry, and only for the specific case of
    // a truncated response (finishReason === "length") on the FIRST attempt
    // — that's a recoverable, predictable failure (budget was just too
    // small), unlike a genuine parse failure. Previously any single-shot
    // failure — including simple truncation — fell straight through to the
    // full tool loop, which then re-did the ENTIRE task from scratch with
    // its own model calls: the user paid for a truncated single-shot
    // attempt AND the full multi-turn loop for the same request. Recovering
    // in-place here with a bigger cap is far cheaper than that fallback.
    for (let shotAttempt = 0; shotAttempt < 2; shotAttempt++) {
      // Retry on rate-limit here too — previously a single 429 made
      // single-shot bail out instantly and fall back to the legacy tool loop,
      // which then did its OWN much longer retry dance (up to 6 attempts per
      // loop iteration, multiple iterations) until it hit the hard time
      // budget. Retrying once here, at the cheap single-call stage, is far
      // less costly than falling through to that.
      let rateLimited = false;
      for (let rlAttempt = 0; rlAttempt < 4; rlAttempt++) {
        text = "";
        try {
          result = await timeModelCall(() => chatFn({
            messages: singleShotMessages,
            tools: null,
            model: effectiveModel,
            maxTokens: singleShotMaxTokens,
            signal,
            onChunk: (chunk) => {
              if (chunk.type === "content") {
                text += chunk.text;
                onEvent({ type: "reasoning", text: chunk.text, delta: true });
              }
            }
          }));
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          if (isRateLimit(err) && rlAttempt < 3) {
            const delay = Math.min(2000 * Math.pow(1.8, rlAttempt), 15000);
            perf.rateLimitWaitMs += delay;
            perf.rateLimitHits++;
            onEvent({ type: "rate_limit", attempt: rlAttempt + 1, delay, message: err.message || "Rate limited, retrying…" });
            await sleep(delay);
            continue;
          }
          // Model call itself failed (non-rate-limit, or retries exhausted) —
          // no point retrying single-shot further, let the normal loop's own
          // retry/backoff handle it.
          onEvent({ type: "status", text: "Single-shot генерация не удалась, переключаюсь на обычный режим…" });
          rateLimited = true;
          break;
        }
      }
      if (rateLimited) return null;

      const fullText = result?.content || text;
      ({ files, deletions, rejected, summary } = parseSingleShotResponse(fullText));

      if (files.length > 0 || deletions.length > 0) break; // parsed fine, stop retrying

      const truncated = result?.finishReason === "length";
      if (truncated && !budgetAlreadyBumped) {
        budgetAlreadyBumped = true;
        singleShotMaxTokens = Math.min(Math.round(singleShotMaxTokens * 1.6), 30000);
        onEvent({ type: "status", text: `Ответ обрезан по лимиту токенов, пробую ещё раз с более высоким лимитом (${singleShotMaxTokens})…` });
        continue; // one more shotAttempt with the bumped cap
      }

      // Nothing parsed and either not a truncation, or already retried once
      // => model ignored the format (or this genuinely needed tools, e.g.
      // it tried to web_fetch something). Bail to the tool loop rather than
      // showing the user a raw, unparsed dump.
      onEvent({
        type: "status",
        text: truncated
          ? `Ответ снова обрезан по лимиту токенов (${singleShotMaxTokens}), не удалось разобрать файлы — переключаюсь на обычный режим…`
          : "Не удалось разобрать одношаговый ответ, переключаюсь на обычный режим…"
      });
      return null;
    }

    for (const f of files) {
      fsMap.set(f.path, f.content);
      changedPaths.push(f.path);
      onEvent({ type: "file", path: f.path, content: f.content });
    }
    for (const p of deletions) {
      if (fsMap.has(p)) {
        fsMap.delete(p);
        changedPaths.push(p);
        onEvent({ type: "file", path: p, content: null, deleted: true });
      }
    }
    if (rejected.length) {
      onEvent({ type: "status", text: `Пропущены небезопасные пути: ${rejected.join(", ")}` });
    }
    if (result?.finishReason === "length") {
      onEvent({ type: "status", text: "⚠ Ответ модели был обрезан по лимиту токенов — последний файл мог не войти. Если чего-то не хватает, напишите «продолжи»." });
    }

    if (result?.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += result.usage.completion_tokens || 0;
      budget.addUsage(result.usage);
    }

    const changedCount = files.length + deletions.length;
    const finalText = summary || (isSingleShotEdit ? `Готово — изменено файлов: ${changedCount}.` : `Готово — создано файлов: ${files.length}.`);
    messages.push({ role: "assistant", content: finalText });
    onEvent({ type: "final", text: finalText });
    return await finalizeTurn();
  }

  if (canUseSingleShot) {
    const singleShotResult = await runSingleShotPath();
    if (singleShotResult) return singleShotResult;
    // else: fall through to the regular tool-based loop below (Conversations
    // API path or legacy loop, whichever applies)
  }

  // This is now the real execution path for the normal "code" tool loop on
  // Mistral models (mode "single", no requireApproval/planApproval, no
  // attached images — those keep using the vision/approval-aware paths
  // below since Conversations-side vision content types and approval
  // gating aren't wired up yet). council/collab still run their own flows
  // (runCouncil/runSubagent) which stay on chat.completions internally.
  const canUseConversationsPath =
    !isGemini &&
    !isCloudflare &&
    mode === "single" &&
    !requireApproval &&
    !requirePlanApproval &&
    !(images && images.length > 0);

  if (canUseConversationsPath) {
    return await runConversationsPath();
  }

  async function runConversationsPath() {
    const instructions = SYSTEM_PROMPT + leadingNote + memoryBlock;
    const agentTools = activeTools; // same {type:"function", function:{...}} schemas as before

    let agentId;
    try {
      agentId = await ensureAgent({ model: effectiveModel, instructions, tools: agentTools, reasoningEffort });
    } catch (err) {
      emitError(onEvent, `Не удалось создать/получить Agent в Mistral: ${err.message}`, err);
      return await stopWithProgress(`не удалось создать/получить Agent в Mistral (${err.message})`);
    }

    const agentKey = `${effectiveModel}::${instructions.length}::${agentTools.length}::${reasoningEffort}`;
    const cacheEntry = chatId ? conversationCache.get(chatId) : null;
    const canAppend = cacheEntry && cacheEntry.agentKey === agentKey;

    // Streams assistant text live as it's generated instead of waiting for
    // the whole turn (this is the actual "official app feels faster" fix —
    // same total tokens, but the UI shows progress immediately). Reset
    // before each fetch call; checked right after to decide whether the
    // full accumulated `text` still needs to be emitted as a fallback.
    let sawStreamedChunk = false;
    const onChunk = (piece) => {
      sawStreamedChunk = true;
      onEvent({ type: "reasoning", text: piece, delta: true });
    };

    // Same per-turn adaptive output cap as the chat.completions path
    // (mistralClient.js) — without this, Conversations API turns had NO
    // max_tokens at all (only a flat 8000 baked into the agent as a
    // fallback), meaning a "simple site" could generate far more than
    // needed. Real tokens/time, not perceived latency.
    const completionArgs = { max_tokens: getMaxTokens(rawLastPrompt) };

    let outputs;
    let convUsage = null;
    try {
      if (canAppend) {
        // Only the NEW user turn is sent — Mistral already has everything
        // before it stored server-side under this conversation_id. This is
        // the actual token/latency saving vs. the old approach.
        ({ outputs, usage: convUsage } = await appendConversation({
          conversationId: cacheEntry.conversationId,
          inputs: [{ role: "user", content: rawLastPrompt }],
          onChunk,
          completionArgs
        }));
      } else {
        // First turn for this chat (or the agent config changed, e.g. a
        // different model/reasoning was picked) — seed the conversation
        // with the full history once, then cache the conversation_id.
        const seedInputs = workingHistory.map((m) => ({ role: m.role, content: m.content }));
        const started = await startConversation({ agentId, inputs: seedInputs, onChunk, completionArgs });
        outputs = started.outputs;
        convUsage = started.usage;
        if (chatId) conversationCache.set(chatId, { conversationId: started.conversationId, agentKey });
      }
    } catch (err) {
      emitError(onEvent, `Mistral Conversations API error: ${err.message}`, err);
      return await stopWithProgress(`ошибка Mistral Conversations API (${err.message})`);
    }
    if (convUsage) budget.addUsage(convUsage);

    let convLoops = 0;
    while (convLoops < MAX_LOOPS) {
      convLoops++;
      if (signal?.aborted) throw new Error("Aborted");
      const graceResult = await checkTimeAndGrace(convLoops);
      if (graceResult) return graceResult;

      const text = extractText(outputs);
      if (text && !sawStreamedChunk) onEvent({ type: "reasoning", text });

      const functionCalls = extractFunctionCalls(outputs);

      if (functionCalls.length === 0) {
        const safeContent = text && text.length > 0 ? text : "(no response generated)";
        messages.push({ role: "assistant", content: safeContent });
        onEvent({ type: "final", text: safeContent });
        return await finalizeTurn();
      }

      const results = [];
      for (const call of functionCalls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        const tName = call.function.name;
        toolTimers.set(tName, Date.now());
        onEvent({ type: "tool_call", name: tName, args, ts: Date.now() });
        budget.addToolCall(tName);

        let execResult;
        if (tName === "save_memory") {
          try {
            const saveOutcome = await saveMemory(memoryKey, { text: args.text, category: args.category });
            if (saveOutcome.saved) onEvent({ type: "memory_saved", entry: saveOutcome.entry });
            execResult = { result: saveOutcome.saved ? "Saved to project memory." : `Not saved (${saveOutcome.reason || "already known"}).` };
          } catch (err) {
            execResult = { error: err.message };
          }
        } else {
          execResult = await timeToolCall(() => executeTool(tName, args, fsMap));
        }

        if (execResult.fileChanged) {
          changedPaths.push(execResult.fileChanged);
          onEvent({ type: "file", path: execResult.fileChanged, content: fsMap.get(execResult.fileChanged) });
        }
        if (execResult.filesChanged && execResult.filesChanged.length) {
          for (const p of execResult.filesChanged) {
            changedPaths.push(p);
            onEvent({ type: "file", path: p, content: fsMap.get(p) });
          }
        }
        if (tName === "run_tests") {
          testRuns.push(execResult);
          lastTestRunFailed = !!execResult?.result?.failed || !!execResult?.error;
        }

        onEvent({ type: "tool_result", name: tName, ok: !execResult.error });
        results.push({
          type: "function.result",
          tool_call_id: call.id,
          result: JSON.stringify(execResult.error ? { error: execResult.error } : execResult.result)
        });
      }

      const budgetEvent = budget.check();
      if (budgetEvent) {
        onEvent({ type: "budget_warning", ...budgetEvent, snapshot: budget.snapshot() });
        if (budgetEvent.exceeded) {
          onEvent({ type: budgetPause ? "status" : "error", message: `Budget limit (${budgetEvent.kind}) reached — stopping.` });
          return await stopWithProgress(`превышен бюджет хода (${budgetEvent.kind}: ${budgetEvent.value} / ${budgetEvent.limit})`);
        }
      }

      try {
        const convId = chatId ? conversationCache.get(chatId)?.conversationId : null;
        if (!convId) throw new Error("Lost conversation id mid-turn.");
        sawStreamedChunk = false;
        ({ outputs, usage: convUsage } = await appendConversation({ conversationId: convId, inputs: results, onChunk, completionArgs }));
        if (convUsage) budget.addUsage(convUsage);
      } catch (err) {
        emitError(onEvent, `Mistral Conversations API error: ${err.message}`, err);
        return await stopWithProgress(`ошибка Mistral Conversations API (${err.message})`);
      }
    }

    onEvent({ type: "error", message: "Агент превысил лимит шагов цикла (MAX_LOOPS)." });
    return await stopWithProgress(`достигнут лимит шагов цикла (${MAX_LOOPS})`);
  }

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    {
      const graceResult = await checkTimeAndGrace(loopCount);
      if (graceResult) return graceResult;
    }

    let currentText = "";
    let result = null;
    // Retry loop for rate-limit stalls — never abort the whole turn on 429,
    // just back off, persist what we have, and continue the agent loop.
    // Economy: trim history for API to save tokens (full history kept for persistence)
    const apiMessages = trimForEconomy(messages);
    for (let rlAttempt = 0; rlAttempt < 6; rlAttempt++) {
      try {
        result = await timeModelCall(() => chatFn({
          messages: apiMessages,
          tools: activeTools,
          builtinTools,
          reasoningEffort,
          model: effectiveModel,
          signal,
          onChunk: (chunk) => {
            if (chunk.type === "content") {
              currentText += chunk.text;
              onEvent({ type: "reasoning", text: chunk.text });
            }
          }
        }));
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (isRateLimit(err) && rlAttempt < 5) {
          const delay = 2000 * Math.pow(1.8, rlAttempt) + Math.floor(Math.random() * 800);
          const capped = Math.min(delay, 25000);
          perf.rateLimitWaitMs += capped;
          perf.rateLimitHits++;
          onEvent({ type: "rate_limit", attempt: rlAttempt + 1, delay: capped, message: err.message || "Rate limited, retrying…" });
          // Persist intermediate progress so a later hard-fail does not lose work
          onEvent({ type: "files", files: fsToArray(fsMap) });
          // also emit usage so toolbar doesn't jump
          if (totalUsage.prompt_tokens || totalUsage.completion_tokens) onEvent({ type: "usage", usage: totalUsage });
          await sleep(capped);
          continue;
        }
        // non-rate-limit or exhausted after retries — save progress and finish gracefully instead of crashing the job
        onEvent({
          type: "error",
          message: isRateLimit(err)
            ? `Превышен лимит запросов (429). Прогресс сохранён — ${fsMap.size} файлов.`
            : (err.message || String(err))
        });
        onEvent({ type: "files", files: fsToArray(fsMap) });
        return await stopWithProgress(isRateLimit(err) ? "лимит запросов к модели (429)" : `ошибка модели (${err.message || err})`);
      }
    }
    if (!result) {
      onEvent({ type: "error", message: "Не удалось получить ответ модели после нескольких попыток (rate limit)." });
      return await stopWithProgress("не удалось получить ответ модели после нескольких попыток (rate limit)");
    }

    if (result.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += result.usage.completion_tokens || 0;
      budget.addUsage(result.usage);
    }

    // Advisory only — never aborts the run, just lets the UI show the user
    // this turn is getting expensive/long before it hits the hard MAX_LOOPS
    // wall with no warning at all.
    const budgetEvent = budget.check();
    if (budgetEvent) {
      onEvent({ type: "budget_warning", ...budgetEvent, snapshot: budget.snapshot() });
      if (budgetEvent.exceeded) {
        const reason = `превышен бюджет хода (${budgetEvent.kind}: ${budgetEvent.value} / ${budgetEvent.limit})`;
        if (budgetPause) {
          onEvent({ type: "status", text: `Пауза по лимиту (${budgetEvent.kind}); продолжи вручную` });
          onEvent({ type: "budget_warning", ...budgetEvent, level: "paused", snapshot: budget.snapshot() });
          return await stopWithProgress(reason);
        }
        onEvent({ type: "error", message: `Hard budget limit exceeded (${budgetEvent.kind}: ${budgetEvent.value} / ${budgetEvent.limit}). Aborting.` });
        return await stopWithProgress(reason);
      }
    }

    // No tool calls: this is the final assistant answer
    if (!result.toolCalls || result.toolCalls.length === 0) {
      // Guard against Mistral's "content or tool_calls, but not none" 400:
      // a turn can legitimately come back with empty content AND no tool
      // calls (dropped stream, model stopped early, etc). Never push an
      // assistant message with content: "" — fall back to a visible marker
      // instead of silently poisoning the next request in this conversation.
      const safeContent = result.content && result.content.length > 0
        ? result.content
        : "(no response generated)";
      messages.push({ role: "assistant", content: safeContent });
      onEvent({ type: "final", text: safeContent });
      return await finalizeTurn();
    }

    // Assistant turn with tool calls. Mistral rejects content:"" here too
    // (must be a non-empty string OR null) — normalize explicitly rather
    // than relying on `|| null`, which already worked but was easy to
    // break by refactor; keep it explicit and commented so it stays fixed.
    messages.push({
      role: "assistant",
      content: result.content && result.content.length > 0 ? result.content : null,
      tool_calls: result.toolCalls
    });

    const turnSignature = JSON.stringify(result.toolCalls.map((c) => [c.function.name, c.function.arguments || ""]));
    if (turnSignature === repeatedTurnSignature) repeatedTurnCount++;
    else { repeatedTurnSignature = turnSignature; repeatedTurnCount = 0; }
    if (repeatedTurnCount >= 2) {
      onEvent({ type: "error", message: "Агент повторяет один и тот же набор действий — остановил цикл, чтобы не тратить время." });
      return await stopWithProgress("агент повторял один и тот же вызов инструмента без прогресса");
    }

    const preparedCalls = result.toolCalls.map((call) => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      return { call, args };
    });

    const executePrepared = async ({ call, args }) => {
      const tName = call.function.name;
      toolTimers.set(tName, Date.now());
      onEvent({ type: "tool_call", name: tName, args, ts: Date.now() });
      budget.addToolCall(tName);

      if (call.function.name === "delegate_to_subagent") {
        onEvent({ type: "subagent_start", task: args.task });
        let report;
        try {
          report = await runSubagent({
            task: args.task,
            relevantFiles: args.relevant_files,
            fsMap,
            toolDefinitions,
            executeTool,
            onEvent,
            signal
          });
        } catch (err) {
          report = `Subagent failed: ${err.message}`;
        }
        onEvent({ type: "subagent_done", report });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({ result: report })
        });
        return;
      }

      if (call.function.name === "save_memory") {
        let saveOutcome;
        try {
          saveOutcome = await saveMemory(memoryKey, { text: args.text, category: args.category });
        } catch (err) {
          saveOutcome = { saved: false, reason: err.message };
        }
        if (saveOutcome.saved) {
          onEvent({ type: "memory_saved", entry: saveOutcome.entry });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify(
            saveOutcome.saved
              ? { result: "Saved to project memory." }
              : { result: `Not saved (${saveOutcome.reason || "already known"}).` }
          )
        });
        return;
      }

      // --- Diff review gate ---
      // For write_file/edit_file/delete_file, when the caller opted into
      // approval mode, pause here and ask before touching fsMap at all —
      // computing the "before" state from the CURRENT fsMap (not the
      // pre-turn snapshot) so a chain of edits within the same turn each
      // shows a correct diff against the immediately preceding version.
      const WRITE_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);
      if (requireApproval && WRITE_TOOLS.has(call.function.name) && typeof onApprovalNeeded === "function") {
        const path = args.path;
        const before = fsMap.get(path) ?? null;
        let after = null;
        if (call.function.name === "write_file") {
          after = args.content ?? "";
        } else if (call.function.name === "edit_file") {
          after =
            before != null && typeof args.old_text === "string"
              ? before.split(args.old_text).join(args.new_text ?? "")
              : null;
        } else {
          after = null; // delete
        }

        let approved = true;
        try {
          approved = await onApprovalNeeded({ path, kind: call.function.name, before, after });
        } catch {
          approved = false;
        }

        if (!approved) {
          onEvent({ type: "diff_rejected", path, kind: call.function.name });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify({ result: `Change to ${path} was rejected by the user. Do not retry the same change without asking why.` })
          });
          return;
        }
        onEvent({ type: "diff_approved", path, kind: call.function.name });
      }

      const execResult = await timeToolCall(() => executeTool(call.function.name, args, fsMap));
      if (execResult.fileChanged) changedPaths.push(execResult.fileChanged);
      if (execResult.filesChanged) changedPaths.push(...execResult.filesChanged);
      if (execResult.testRun) {
        testRuns.push(execResult.testRun);
        lastTestRunFailed = !execResult.testRun.ok;
      }

      if (execResult.isPlan) {
        lastPlan = execResult.result;
        onEvent({ type: "plan", plan: execResult.result });
        // Plan approval gate: pause and wait for the user to approve (button
        // or text) before doing any real work. The request that started the
        // (detached) job supplies onPlanApproveNeeded; if none is wired we
        // proceed automatically so an unattended job still makes progress.
        if (requirePlanApproval && typeof onPlanApproveNeeded === "function") {
          let approved = true;
          let note = "";
          try {
            const res = await onPlanApproveNeeded({ plan: execResult.result });
            approved = res?.approved !== false;
            note = res?.note || "";
          } catch {
            approved = false;
          }
          if (approved) {
            onEvent({ type: "plan_approved", note });
          } else {
            onEvent({ type: "plan_rejected", note });
          }
        }
      }
      if (execResult.fileChanged) {
        onEvent({
          type: "file",
          path: execResult.fileChanged,
          content: fsMap.get(execResult.fileChanged)
        });
      }
      if (execResult.fileDeleted) {
        onEvent({ type: "file_deleted", path: execResult.fileDeleted });
      }
      if (execResult.filesChanged && execResult.filesChanged.length) {
        // run_command can touch many files at once (npm init, test runs, etc.)
        for (const p of execResult.filesChanged) {
          onEvent({ type: "file", path: p, content: fsMap.get(p) });
        }
      }
      if (execResult.terminalCommand) {
        onEvent({
          type: "terminal",
          command: execResult.terminalCommand,
          output: execResult.result
        });
      }
      if (execResult.testRun) {
        onEvent({ type: "test_run", ...execResult.testRun });
      }

      const dur = toolTimers.has(call.function.name) ? Date.now() - toolTimers.get(call.function.name) : null;
      toolTimers.delete(call.function.name);
      onEvent({
        type: "tool_result",
        name: call.function.name,
        result: execResult.error || execResult.result,
        durationMs: dur
      });

      // Mark a plan step as completed for each meaningful mutating action so
      // the UI plan card checks off progress in real time.
      const MUTATING = new Set(["write_file", "edit_file", "delete_file", "run_command", "rename_file", "delegate_to_subagent"]);
      if (MUTATING.has(call.function.name)) {
        planStepDone++;
        onEvent({ type: "plan_step", completed: planStepDone });
      }

      // Safety: ensure tool message content is always a string (prevents Mistral 422 "Field required")
      let toolContent;
      if (execResult.error) toolContent = JSON.stringify({ error: execResult.error });
      else if (execResult.result !== undefined) toolContent = JSON.stringify(execResult.result);
      else toolContent = JSON.stringify(execResult);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: toolContent || "{}"
      });
    };

    const { readOnly: readCalls, ordered: writeCalls } = splitToolCalls(preparedCalls.map(({ call }) => call));
    // Reads/searches are independent and can run together; mutations remain ordered.
    // We restore the original tool-call order before handing the batch back to the model.
    if (readCalls.length) {
      const start = messages.length;
      await Promise.all(readCalls.map((item) => executePrepared(preparedCalls.find((p) => p.call === item.call))));
      const readResults = messages.splice(start);
      const order = new Map(readCalls.map((item, index) => [item.call.id, index]));
      readResults.sort((a, b) => (order.get(a.tool_call_id) ?? 0) - (order.get(b.tool_call_id) ?? 0));
      messages.push(...readResults);
    }
    for (const item of writeCalls) await executePrepared(preparedCalls.find((p) => p.call === item.call));
  }

  return await stopWithProgress(`достигнут лимит шагов цикла (${MAX_LOOPS})`);
}
