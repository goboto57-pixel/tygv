import { streamMistralChat, VISION_MODEL } from "./mistralClient.js";
import { streamGeminiChat } from "./geminiClient.js";
import { toolDefinitions } from "./toolDefinitions.js";
import { executeTool, createFSFromFiles, fsToArray } from "./projectFS.js";
import { enhancePrompt } from "./promptEnhancer.js";
import { runCouncil, delegateSubagentTool, runSubagent } from "./orchestrator.js";
import { loadMemory, saveMemory, renderMemoryForPrompt } from "./memoryService.js";
import { splitToolCalls } from "./toolExecution.js";
import { createBudgetTracker } from "./budgetTracker.js";
import { computeSessionMetrics } from "./sessionMetrics.js";

const SYSTEM_PROMPT = `You are CodeForge — fast, token-efficient coding agent (Mistral). Build working software quickly.

Rules:
1. For complex tasks call make_plan FIRST; trivial 1-file fixes need no plan.
2. Prefer static HTML/CSS/JS (no build). Only use framework if user asks.
3. When done, summarize and STOP — no more tool calls. Never run dev server; use run_command if needed.
4. Use file tools: list_directory_tree, read_file(s), write_file, edit_file, delete/rename, find_files, search_code, grep, lint_file, web_fetch. Batch reads.
5. Return files via tools only — never paste code in chat.
6. Read before edit if unsure; use list_directory_tree for structure.
7. Briefly explain reasoning (shown as thought); code only in tools.
8. edit_file for small patches, write_file for new/full rewrites.
9. grep for regex, search_code for plain text, semantic_search for concepts, web_fetch for docs.
10. Verify: read back key file, lint_file, check_preview for sites, run tests if possible. Never claim failing tests pass.
11. Clean, production code — no over-engineering or extra features.
12. End with concise summary + run/preview steps.
13. Be direct, no fluff.
14. Save durable facts with save_memory once (deduplicate).

Economy: be concise, avoid redundant reads, prefer batch ops, stop when complete. Simple landing/site must finish in ≤8 tool calls.`;

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

  // --- Step -1: load durable project memory, if any, and fold it into the system prompt ---
  const memoryEntries = await loadMemory(memoryKey);
  const memoryBlock = renderMemoryForPrompt(memoryEntries);

  // --- Step 0: sharpen the user's last message before anything else touches it ---
  // (see promptEnhancer.js for why this exists — most "ugly site" complaints are vague-prompt problems)
  let workingHistory = history;
  const rawLastPrompt = history[history.length - 1]?.content || "";
  const needsEnhancement = /(?:сайт|дизайн|интерфейс|ui|ux|лендинг|страниц|красив|улучш|добавь|сделай|приложен|website|design|landing|interface)/i.test(rawLastPrompt)
    && !/(?:stack trace|exception|error at|line \d+|syntax|undefined|cannot read|import .* from|function .*\()/i.test(rawLastPrompt);
  if (enhance && needsEnhancement && history.length > 0 && history[history.length - 1].role === "user") {
    const lastMsg = history[history.length - 1];
    const { enhanced, original, changed } = await enhancePrompt(lastMsg.content, { signal });
    if (changed) {
      workingHistory = [...history.slice(0, -1), { ...lastMsg, content: enhanced }];
      onEvent({ type: "prompt_enhanced", original, enhanced });
    }
  }

  let effectiveModel = model;
  let extraTools = [];
  let leadingNote = "";

  // --- Step 1: mode-specific setup ---
  if (mode === "council") {
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
  const activeTools = [...baseTools, ...extraTools];

  const messages = [{ role: "system", content: SYSTEM_PROMPT + leadingNote + memoryBlock }, ...workingHistory];

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
    if (/(фикс|поправь|исправь|мелкий|one.?line|small fix)/i.test(prompt) && prompt.length < 120) return 10;
    if (/(простой сайт|одностраничник|лендинг|landing)/i.test(prompt)) return 14;
    if (/(сайт|приложение|app|website|страниц)/i.test(prompt)) return 22;
    if (/(большой|сложный|enterprise|full.?stack|многостраничный)/i.test(prompt)) return 28;
    return 20;
  };
  const MAX_LOOPS = getAdaptiveLoops(rawLastPrompt);
  const trimForEconomy = (msgs) => {
    if (msgs.length <= 16) return msgs;
    return [msgs[0], ...msgs.slice(-12)];
  };
  // For simple tasks drop heavy tools to save ~400 tokens/call
  const isSimpleEconomy = /(простой сайт|одностраничник|лендинг|simple site|landing page|простой)/i.test(rawLastPrompt);
  const baseTools = isSimpleEconomy
    ? toolDefinitions.filter((t) => !["semantic_search", "run_tests", "delegate_to_subagent"].includes(t.function.name))
    : toolDefinitions;
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
      onEvent({ type: "tool_call", name: call.function.name, args });

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
      if (execResult.fileChanged) changedPaths.push(execResult.fileChanged);
      if (execResult.filesChanged) changedPaths.push(...execResult.filesChanged);
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

      onEvent({
        type: "tool_result",
        name: call.function.name,
        result: execResult.error || execResult.result
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

  onEvent({ type: "final", text: "Reached maximum tool-call iterations for this turn. Please continue in a follow-up message." });
  return await finalizeTurn();
}
