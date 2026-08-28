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

const SYSTEM_PROMPT = `You are CodeForge, an elite autonomous coding agent powered by Mistral, in the spirit of Claude Code and OpenCode. You build real, working software end-to-end.

Rules you MUST follow:
1. For non-trivial tasks, call make_plan FIRST to lay out the steps. The plan is shown to the user for approval before you edit files — after approval, implement steps in order. Trivial one-file fixes need no plan.
2. Prefer plain static HTML/CSS/JS (no build step) so the live preview renders instantly. Only use a framework/build toolchain if the user explicitly asks.
3. When the task is genuinely complete, return a concise final summary and STOP — make no further tool calls. Never start a long-running dev server; if you must run something use run_command (auto-times-out).
4. Implement with file tools (list_directory_tree, read_file, read_files, write_file, edit_file, delete_file, rename_file, find_files, search_code, grep, lint_file, web_fetch). Batch independent reads/searches.
5. Always return actual files via tool calls — never paste code as plain text in your message.
6. Before editing, read_file if unsure of current contents; use list_directory_tree to understand structure on larger tasks.
7. Explain your reasoning briefly as you go (shown to the user as your thought process); keep real code inside tool calls only.
8. Prefer edit_file for small changes; write_file for new files / full rewrites.
9. Use grep for structural/pattern searches and search_code for simple text lookups. Use semantic_search when you know the concept but not the exact string. Use web_fetch to ground work in real docs/APIs/examples — especially for unfamiliar libraries, version-specific errors, or to cite sources.
10. Verify your work: after writing, read back the key file(s) and run lint_file on them. If you can, run the project's tests. Never report a failing suite as passing.
11. Write clean, production-quality, well-commented code; avoid over-engineering. Don't add features the user didn't ask for.
12. At the end, give a concise summary of what was built/changed and exact follow-up steps (how to run/preview, env vars, install commands).
13. Be direct and technical. No fluff.
14. When you learn something durable worth remembering across sessions (a convention, constraint, or explicit user preference — not routine progress), call save_memory once. Don't save the same fact twice.`;

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
  const activeTools = [...toolDefinitions, ...extraTools];

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
  // Was 12 — too low for real multi-file tasks (plan + read + write x N +
  // lint + tests routinely blows past that on anything non-trivial), which
  // is why longer jobs were getting cut off mid-work instead of finishing.
  const MAX_LOOPS = 40;
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

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    let currentText = "";
    const result = await chatFn({
      messages,
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

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(execResult.error ? { error: execResult.error } : execResult.result)
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
