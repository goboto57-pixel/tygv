import { streamMistralChat, VISION_MODEL } from "./mistralClient.js";
import { streamGeminiChat } from "./geminiClient.js";
import { toolDefinitions } from "./toolDefinitions.js";
import { executeTool, createFSFromFiles, fsToArray } from "./projectFS.js";
import { enhancePrompt } from "./promptEnhancer.js";
import { runCouncil, delegateSubagentTool, runSubagent } from "./orchestrator.js";

const SYSTEM_PROMPT = `You are CodeForge, an elite autonomous coding agent powered by Mistral, in the spirit of Claude Code and OpenCode.

Rules you MUST follow:
1. For any non-trivial coding task (more than a one-line fix), you MUST call make_plan FIRST, before writing any code, laying out clear steps.
2. After the plan is presented, proceed to implement it using the file tools (list_directory_tree, read_file, read_files, write_file, edit_file, delete_file, rename_file, find_files, search_code, grep, lint_file).
3. Always return actual files via tool calls (write_file / edit_file) — never just paste code as plain text in your message.
4. Before editing, read_file if you're not sure of current contents. Use list_directory_tree to understand project structure on larger tasks.
5. Explain your reasoning briefly as you go (this is shown to the user as your thought process), but keep actual code inside tool calls only.
6. Prefer edit_file for small changes; use write_file for new files or full rewrites.
7. Use grep for structural/pattern searches (imports, function signatures) and search_code for simple text lookups. Use semantic_search instead when you know *what* you're looking for conceptually but not the exact string to grep for (e.g. "where user permissions are checked").
8. Use lint_file after significant edits to a file to catch obvious mistakes before finishing.
9. For any new logic/behavior (functions, components, endpoints), write actual test files alongside the code (co-located *.test.js/*.spec.js, or test_*.py for Python), then call run_tests to execute them. If tests fail, fix the code or the test and run again before finishing — don't report a task as done with failing tests. If the project has no test runner set up at all (no framework installed), say so explicitly in your summary instead of skipping tests silently.
9. Write clean, production-quality, well-commented code following best practices for the language/framework in use.
10. When the task is complete, give a concise summary of what was built/changed and any follow-up steps the user should take (e.g. npm install, environment variables).
11. Be direct and technical. No fluff.`;

/**
 * Runs the full agent loop for one user turn, streaming events via onEvent.
 * onEvent receives: { type: 'reasoning'|'tool_call'|'tool_result'|'plan'|'file'|'final'|'usage'|
 *                      'prompt_enhanced'|'council'|'subagent_start'|'subagent_done', ...payload }
 *
 * mode:
 *   - "single"  : one model runs the whole agent loop (default, model = settings.model)
 *   - "council" : Gemini 2.5 Pro + Mistral Large independently analyze the task and Mistral Large
 *                 merges both views into one plan, which then seeds a normal Mistral Large-driven loop
 *   - "collab"  : Mistral Large chairs the task and can delegate focused sub-tasks to Devstral
 *                 subagents via the delegate_to_subagent tool, instead of doing everything itself
 */
export async function runAgentLoop({ history, files, model, mode = "single", enhance = true, images, onEvent, signal }) {
  const fsMap = createFSFromFiles(files);

  // --- Step 0: sharpen the user's last message before anything else touches it ---
  // (see promptEnhancer.js for why this exists — most "ugly site" complaints are vague-prompt problems)
  let workingHistory = history;
  if (enhance && history.length > 0 && history[history.length - 1].role === "user") {
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

  const isGemini = effectiveModel === "gemini-2.5-pro" || effectiveModel === "gemini-2.5-flash";
  const chatFn = isGemini ? streamGeminiChat : streamMistralChat;
  const activeTools = [...toolDefinitions, ...extraTools];

  const messages = [{ role: "system", content: SYSTEM_PROMPT + leadingNote }, ...workingHistory];

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
  const MAX_LOOPS = 12;

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
    }

    // No tool calls: this is the final assistant answer
    if (!result.toolCalls || result.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: result.content });
      onEvent({ type: "final", text: result.content });
      onEvent({ type: "usage", usage: totalUsage });
      onEvent({ type: "files", files: fsToArray(fsMap) });
      return { messages, files: fsToArray(fsMap), usage: totalUsage };
    }

    // Assistant turn with tool calls
    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls
    });

    for (const call of result.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }

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
        continue;
      }

      const execResult = await executeTool(call.function.name, args, fsMap);

      if (execResult.isPlan) {
        onEvent({ type: "plan", plan: execResult.result });
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

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(execResult.error ? { error: execResult.error } : execResult.result)
      });
    }
  }

  onEvent({ type: "final", text: "Reached maximum tool-call iterations for this turn. Please continue in a follow-up message." });
  onEvent({ type: "usage", usage: totalUsage });
  onEvent({ type: "files", files: fsToArray(fsMap) });
  return { messages, files: fsToArray(fsMap), usage: totalUsage };
}
