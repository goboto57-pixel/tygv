import { streamMistralChat, VISION_MODEL, IMAGE_GENERATION_TOOL } from "./mistralClient.js";
import { streamGeminiChat } from "./geminiClient.js";
import { toolDefinitions } from "./toolDefinitions.js";
import { executeTool, createFSFromFiles, fsToArray } from "./projectFS.js";
import { runCouncil, delegateSubagentTool, runSubagent } from "./orchestrator.js";
import { loadMemory, saveMemory, renderMemoryForPrompt } from "./memoryService.js";
import { splitToolCalls } from "./toolExecution.js";
import { createBudgetTracker } from "./budgetTracker.js";
import { computeSessionMetrics } from "./sessionMetrics.js";
import { runMistralWebSearch } from "./webSearchClient.js";
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
4b. Creating/overwriting more than one file in the same turn? Use write_files with ALL of them in ONE call — never one write_file per file. Same for reads (read_files) and lint (lint_files). Every extra tool call costs a full network round trip AND real generation time — this is not a UI/perceived-latency thing, it is actual minutes and actual tokens.
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

/** Short prompt for simple static sites — saves ~600–900 tokens per model call. */
const SYSTEM_PROMPT_SIMPLE = `You are CodeForge — fast coding agent. Build a working static site quickly.

Rules:
1. Prefer static HTML/CSS/JS. No framework unless user asks.
2. Use write_files ONCE with ALL files (index.html + css + js). Never one write_file per file.
3. After write_files: STOP with a 2–4 line summary. Do NOT lint, do NOT read back, do NOT check_preview unless the user asked to verify.
4. Code only via tools. No code in chat.
5. Be direct. No plan for trivial 1–4 file sites.`;

/**
 * Single-shot creation prompt: model writes ALL files in one text response
 * (markdown fences with path as the language tag). Server parses and materializes
 * files — zero tool round-trips. Used only for empty/greenfield projects.
 */
const SINGLE_SHOT_SYSTEM_PROMPT = `You are CodeForge — a fast code generator. The project is empty; you are creating it from scratch in ONE response.

Rules:
1. Prefer static HTML/CSS/JS (no build/framework) unless the user explicitly asks for React/Vue/etc.
2. Output EVERY file as a fenced code block. The fence language tag MUST be the relative file path, e.g.:
\`\`\`index.html
<!DOCTYPE html>
...
\`\`\`
\`\`\`styles.css
body { ... }
\`\`\`
\`\`\`script.js
...
\`\`\`
3. Paths only — no language name before the path. Do not use \`\`\`html or \`\`\`css; use the path itself as the tag.
4. After all file blocks, write a short (2–5 lines) summary of what you built and how to open/preview it.
5. No tool calls, no plans, no extra commentary before the first fence. Start with the first \`\`\`path block.
6. Clean, production-ready code. No placeholders like "TODO" or lorem unless the user asked for them.
7. Keep the whole site self-contained (relative links, inline or linked CSS/JS in the same project).`;

/**
 * Parse fenced code blocks whose language tag is a file path.
 * Accepts:
 *   ```index.html
 *   ```path/to/file.js
 *   ```html index.html   (fallback: last token that looks like a path)
 * Returns [{ path, content }, ...]
 */
function parseCodeBlocksFromText(text) {
  const files = [];
  if (!text || typeof text !== "string") return files;
  const re = /```([^\n`]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let header = m[1].trim();
    // Strip optional language prefix: "html index.html" / "javascript src/app.js"
    let path = header;
    if (/\s/.test(header)) {
      const parts = header.split(/\s+/).filter(Boolean);
      const pathLike = parts.find((p) => /[./]/.test(p) || /\.\w{1,8}$/.test(p));
      path = pathLike || parts[parts.length - 1];
    }
    path = path.replace(/^\/+/, "").replace(/\.\./g, "").trim();
    // Reject obvious non-paths (bare language names, empty)
    if (!path || path.length > 200 || !/[\w.-]/.test(path)) continue;
    // Prefer something that looks like a filename
    if (!/\.\w{1,12}$/.test(path) && !path.includes("/")) continue;
    const content = m[2].replace(/\n$/, "");
    files.push({ path, content });
  }
  return files;
}

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

  let effectiveModel = model;
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
  const chatFn = isGemini ? streamGeminiChat : streamMistralChat;

  // Early simple-task flag (also refined later with hasTestSetup). Used for
  // short system prompt + minimal tools + auto-stop after write.
  const isSimpleEconomy =
    fsMap.size === 0 ||
    /(простой сайт|одностраничник|лендинг|simple site|landing page|простой|landing|статич|html.?css|сделай сайт|создай сайт|make (a |me )?(site|page|landing))/i.test(
      rawLastPrompt
    );
  const effectiveSystemPrompt = (isSimpleEconomy ? SYSTEM_PROMPT_SIMPLE : SYSTEM_PROMPT) + leadingNote + memoryBlock;
  const messages = [{ role: "system", content: effectiveSystemPrompt }, ...workingHistory];

  // --- Vision: design-reference screenshots dropped into the chat ---
  // Turns this into a Mistral multimodal message (text + image_url parts) and
  // forces the vision-capable Pixtral model for this turn only, so the agent
  // can actually "see" the reference while still using its normal file tools.
  if (images && images.length > 0 && !isGemini) {
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
  // Economy: adaptive loops — trivial fix 10, simple site 14, site/app 22, big 28
  const getAdaptiveLoops = (prompt) => {
    if (/(фикс|поправь|исправь|мелкий|one.?line|small fix)/i.test(prompt) && prompt.length < 120) return 4;
    if (fsMap.size === 0 || /(простой сайт|одностраничник|лендинг|landing|сделай сайт|создай сайт)/i.test(prompt)) return 4;
    if (/(сайт|приложение|app|website|страниц)/i.test(prompt)) return 10;
    if (/(большой|сложный|enterprise|full.?stack|многостраничный)/i.test(prompt)) return 18;
    return 10;
  };
  const MAX_LOOPS = getAdaptiveLoops(rawLastPrompt);
  const trimForEconomy = (msgs) => {
    if (msgs.length <= 16) return msgs;
    return [msgs[0], ...msgs.slice(-12)];
  };
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
  // Minimal tool set for simple static work — fewer schemas = fewer tokens
  // on every model request (full catalog is ~7–8KB of JSON every turn).
  const SIMPLE_TOOL_ALLOW = new Set([
    "write_files",
    "write_file",
    "edit_file",
    "read_file",
    "read_files",
    "list_directory_tree",
    "list_files",
    "check_preview",
    "delete_file",
    "rename_file"
  ]);
  const baseTools = toolDefinitions.filter((t) => {
    const name = t.function.name;
    if (!hasTestSetup && name === "run_tests") return false;
    if (isSimpleEconomy) return SIMPLE_TOOL_ALLOW.has(name);
    if (["semantic_search", "delegate_to_subagent", "analyze_bundle", "extract_colors", "generate_tests", "todo_scan", "get_project_stats", "refactor"].includes(name)) {
      // Drop rarely-needed tools from the default set to cut schema tokens
      // even on medium tasks (model can still do the job without them).
      return false;
    }
    return true;
  });
  // Image mode: add Mistral's built-in image_generation connector (works in
  // Chat Completions, unlike web_search/code_interpreter) on top of the
  // normal file tools, so the agent can generate an image AND drop it into
  // the project (e.g. as an asset referenced by the site it's building).
  const builtinTools = toolMode === "image" ? [IMAGE_GENERATION_TOOL] : [];
  const activeTools = [...baseTools, ...extraTools];
  // Track whether a successful write happened this turn — used to auto-stop
  // on simple tasks instead of letting the model burn another loop on lint/read.
  let wroteFilesThisTurn = false;
  let repeatedTurnSignature = "";
  let repeatedTurnCount = 0;
  // Keep a bounded loop so an agent cannot spend minutes repeating the same failed tool call.
  // Larger jobs should use batch reads/edits or a follow-up turn rather than an unbounded loop.

  // Tracked across the whole turn for the end-of-session metrics report and
  // for auto-rollback decisions.
  const changedPaths = [];
  const testRuns = [];
  let lastTestRunFailed = false;
  // Number of plan steps the agent has visibly completed, used to check off
  // the plan card in the UI as work progresses.
  let planStepDone = 0;

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
    // Strip system message before persisting - don't store system prompt in DB
    const messagesToPersist = messages.filter((m) => m.role !== "system");
    return { messages: messagesToPersist, files: fsToArray(fsMap), usage: totalUsage, rolledBack };
  }

  // helper for rate-limit detection and backoff
  const isRateLimit = (err) => {
    const msg = String(err?.message || "").toLowerCase();
    return err?.status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- Single-shot greenfield path ---
  // Empty project + create-style request → ONE model call, no tools.
  // Model writes all files as markdown fences; we parse and materialize them.
  // This is the real lever that matches Le Chat-style latency (1 round-trip).
  // Edits of existing projects still use the full tool loop below.
  const isEmptyProject = fsMap.size === 0;
  const isCreationPrompt =
    /(сделай|создай|сгенерируй|напиши|build|create|make|generate|с нуля|from scratch|новый сайт|new (site|app|page))/i.test(rawLastPrompt) ||
    (isEmptyProject && /(сайт|лендинг|landing|website|app|приложение|страниц|page)/i.test(rawLastPrompt));
  const useSingleShot =
    isEmptyProject &&
    isCreationPrompt &&
    toolMode === "code" &&
    mode === "single" &&
    !requireApproval &&
    !requirePlanApproval &&
    !(images && images.length > 0);

  if (useSingleShot) {
    onEvent({ type: "status", text: "Генерация с нуля (single-shot, без тулов)…" });
    const singleMessages = [
      { role: "system", content: SINGLE_SHOT_SYSTEM_PROMPT + memoryBlock },
      ...workingHistory
    ];
    let currentText = "";
    let result = null;
    for (let rlAttempt = 0; rlAttempt < 6; rlAttempt++) {
      try {
        result = await chatFn({
          messages: singleMessages,
          tools: null,
          builtinTools: [],
          reasoningEffort,
          model: effectiveModel,
          signal,
          onChunk: (chunk) => {
            if (chunk.type === "content") {
              currentText += chunk.text;
              onEvent({ type: "reasoning", text: chunk.text, delta: true });
            }
          }
        });
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (isRateLimit(err) && rlAttempt < 5) {
          const delay = Math.min(2000 * Math.pow(1.8, rlAttempt) + Math.floor(Math.random() * 800), 25000);
          onEvent({ type: "rate_limit", attempt: rlAttempt + 1, delay, message: err.message || "Rate limited, retrying…" });
          await sleep(delay);
          continue;
        }
        emitError(onEvent, err.message || String(err), err);
        return await finalizeTurn();
      }
    }
    if (!result) {
      onEvent({ type: "error", message: "Не удалось получить ответ модели (rate limit). Попробуйте снова." });
      return await finalizeTurn();
    }
    if (result.usage) {
      totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += result.usage.completion_tokens || 0;
      budget.addUsage(result.usage);
    }
    const fullText = (result.content && result.content.length > 0 ? result.content : currentText) || "";
    const parsed = parseCodeBlocksFromText(fullText);
    if (parsed.length === 0) {
      // Fallback: model ignored the format — treat whole answer as final text
      const safe = fullText.trim() || "(no response generated)";
      messages.push({ role: "assistant", content: safe });
      onEvent({ type: "final", text: safe });
      return await finalizeTurn();
    }
    for (const { path, content } of parsed) {
      fsMap.set(path, content);
      changedPaths.push(path);
      onEvent({ type: "file", path, content });
      onEvent({ type: "tool_call", name: "write_file", args: { path, content: content.slice(0, 80) + (content.length > 80 ? "…" : "") }, ts: Date.now() });
      onEvent({ type: "tool_result", name: "write_file", ok: true });
    }
    // Summary = any prose outside the fences, or a short default listing files
    const withoutFences = fullText.replace(/```[\s\S]*?```/g, "").trim();
    const summary =
      withoutFences ||
      `Создано ${parsed.length} файл(ов): ${parsed.map((f) => f.path).join(", ")}.`;
    messages.push({ role: "assistant", content: summary });
    onEvent({ type: "final", text: summary });
    return await finalizeTurn();
  }

  // --- Primary path: Mistral Agents + Conversations API ---
  // This is now the real execution path for the normal "code" tool loop on
  // Mistral models (mode "single", no requireApproval/planApproval, no
  // attached images — those keep using the vision/approval-aware paths
  // below since Conversations-side vision content types and approval
  // gating aren't wired up yet). council/collab still run their own flows
  // (runCouncil/runSubagent) which stay on chat.completions internally.
  const canUseConversationsPath =
    !isGemini &&
    mode === "single" &&
    !requireApproval &&
    !requirePlanApproval &&
    !(images && images.length > 0);

  if (canUseConversationsPath) {
    return await runConversationsPath();
  }

  async function runConversationsPath() {
    const instructions = effectiveSystemPrompt;
    const agentTools = activeTools; // same {type:"function", function:{...}} schemas as before

    let agentId;
    try {
      agentId = await ensureAgent({ model: effectiveModel, instructions, tools: agentTools, reasoningEffort });
    } catch (err) {
      emitError(onEvent, `Не удалось создать/получить Agent в Mistral: ${err.message}`, err);
      return await finalizeTurn();
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
    let adaptiveMax = 8000;
    if (/(фикс|поправь|исправь|мелкий|one.?line|small fix)/i.test(rawLastPrompt) && rawLastPrompt.length < 120) adaptiveMax = 2000;
    else if (isSimpleEconomy) adaptiveMax = 4500;
    else if (/(большой|сложный|enterprise|многостраничный)/i.test(rawLastPrompt)) adaptiveMax = 12000;
    const completionArgs = { max_tokens: adaptiveMax };

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
      return await finalizeTurn();
    }
    if (convUsage) budget.addUsage(convUsage);

    let convLoops = 0;
    while (convLoops < MAX_LOOPS) {
      convLoops++;
      if (signal?.aborted) throw new Error("Aborted");

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
          execResult = await executeTool(tName, args, fsMap);
        }

        if (execResult.fileChanged) {
          changedPaths.push(execResult.fileChanged);
          onEvent({ type: "file", path: execResult.fileChanged, content: fsMap.get(execResult.fileChanged) });
          if (tName === "write_file" || tName === "edit_file") wroteFilesThisTurn = true;
        }
        if (execResult.filesChanged && execResult.filesChanged.length) {
          for (const p of execResult.filesChanged) {
            changedPaths.push(p);
            onEvent({ type: "file", path: p, content: fsMap.get(p) });
          }
          if (tName === "write_files") wroteFilesThisTurn = true;
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
          return await finalizeTurn();
        }
      }

      // Simple economy: after a successful write, stop — no extra model call
      // for lint/read/check_preview. Saves a full round-trip + tokens.
      if (isSimpleEconomy && wroteFilesThisTurn) {
        const summary =
          text && text.trim()
            ? text.trim()
            : `Готово: ${[...new Set(changedPaths)].join(", ") || "файлы записаны"}.`;
        messages.push({ role: "assistant", content: summary });
        onEvent({ type: "final", text: summary });
        onEvent({ type: "status", text: "Simple mode: останов после write (без лишних проверок)." });
        return await finalizeTurn();
      }

      try {
        const convId = chatId ? conversationCache.get(chatId)?.conversationId : null;
        if (!convId) throw new Error("Lost conversation id mid-turn.");
        sawStreamedChunk = false;
        ({ outputs, usage: convUsage } = await appendConversation({ conversationId: convId, inputs: results, onChunk, completionArgs }));
        if (convUsage) budget.addUsage(convUsage);
      } catch (err) {
        emitError(onEvent, `Mistral Conversations API error: ${err.message}`, err);
        return await finalizeTurn();
      }
    }

    onEvent({ type: "error", message: "Агент превысил лимит шагов цикла (MAX_LOOPS)." });
    return await finalizeTurn();
  }

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    let currentText = "";
    let result = null;
    // Retry loop for rate-limit stalls — never abort the whole turn on 429,
    // just back off, persist what we have, and continue the agent loop.
    // Economy: trim history for API to save tokens (full history kept for persistence)
    const apiMessages = trimForEconomy(messages);
    for (let rlAttempt = 0; rlAttempt < 6; rlAttempt++) {
      try {
        result = await chatFn({
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
        });
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (isRateLimit(err) && rlAttempt < 5) {
          const delay = 2000 * Math.pow(1.8, rlAttempt) + Math.floor(Math.random() * 800);
          const capped = Math.min(delay, 25000);
          onEvent({ type: "rate_limit", attempt: rlAttempt + 1, delay: capped, message: err.message || "Rate limited, retrying…" });
          // Persist intermediate progress so a later hard-fail does not lose work
          onEvent({ type: "files", files: fsToArray(fsMap) });
          // also emit usage so toolbar doesn't jump
          if (totalUsage.prompt_tokens || totalUsage.completion_tokens) onEvent({ type: "usage", usage: totalUsage });
          await sleep(capped);
          continue;
        }
        // non-rate-limit or exhausted after retries — save progress and finish gracefully instead of crashing the job
        if (isRateLimit(err)) {
          onEvent({ type: "error", message: `Превышен лимит запросов (429). Прогресс сохранён — ${fsMap.size} файлов. Напишите «продолжи» чтобы возобновить.` });
        } else {
          onEvent({ type: "error", message: err.message || String(err) });
        }
        onEvent({ type: "files", files: fsToArray(fsMap) });
        return await finalizeTurn();
      }
    }
    if (!result) {
      onEvent({ type: "error", message: "Не удалось получить ответ модели после нескольких попыток (rate limit). Прогресс сохранён, попробуйте продолжить сообщением «продолжи»." });
      return await finalizeTurn();
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
        if (budgetPause) {
          onEvent({ type: "status", text: `Пауза по лимиту (${budgetEvent.kind}); продолжи вручную` });
          onEvent({ type: "budget_warning", ...budgetEvent, level: "paused", snapshot: budget.snapshot() });
          return await finalizeTurn();
        }
        onEvent({ type: "error", message: `Hard budget limit exceeded (${budgetEvent.kind}: ${budgetEvent.value} / ${budgetEvent.limit}). Aborting.` });
        return await finalizeTurn();
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
      return await finalizeTurn();
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

      const execResult = await executeTool(call.function.name, args, fsMap);
      if (execResult.fileChanged) {
        changedPaths.push(execResult.fileChanged);
        if (call.function.name === "write_file" || call.function.name === "edit_file") wroteFilesThisTurn = true;
      }
      if (execResult.filesChanged) {
        changedPaths.push(...execResult.filesChanged);
        if (call.function.name === "write_files") wroteFilesThisTurn = true;
      }
      if (execResult.testRun) {
        testRuns.push(execResult.testRun);
        lastTestRunFailed = !execResult.testRun.ok;
      }

      if (execResult.isPlan) {
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

    // Simple economy: stop right after a successful write — no second model
    // round-trip for lint/read/verify.
    if (isSimpleEconomy && wroteFilesThisTurn) {
      const summary = `Готово: ${[...new Set(changedPaths)].join(", ") || "файлы записаны"}.`;
      messages.push({ role: "assistant", content: summary });
      onEvent({ type: "final", text: summary });
      onEvent({ type: "status", text: "Simple mode: останов после write (без лишних проверок)." });
      return await finalizeTurn();
    }
  }

  onEvent({ type: "final", text: "Reached maximum tool-call iterations for this turn. Please continue in a follow-up message." });
  return await finalizeTurn();
}
