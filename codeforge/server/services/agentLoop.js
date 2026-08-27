import { streamMistralChat } from "./mistralClient.js";
import { toolDefinitions } from "./toolDefinitions.js";
import { executeTool, createFSFromFiles, fsToArray } from "./projectFS.js";

const SYSTEM_PROMPT = `You are CodeForge, an elite autonomous coding agent powered by Mistral Codestral, in the spirit of Claude Code and OpenCode.

Rules you MUST follow:
1. For any non-trivial coding task (more than a one-line fix), you MUST call make_plan FIRST, before writing any code, laying out clear steps.
2. After the plan is presented, proceed to implement it using the file tools (read_file, write_file, edit_file, delete_file, list_files, search_code).
3. Always return actual files via tool calls (write_file / edit_file) — never just paste code as plain text in your message.
4. Before editing, read_file if you're not sure of current contents.
5. Explain your reasoning briefly as you go (this is shown to the user as your thought process), but keep actual code inside tool calls only.
6. Prefer edit_file for small changes; use write_file for new files or full rewrites.
7. Write clean, production-quality, well-commented code following best practices for the language/framework in use.
8. When the task is complete, give a concise summary of what was built/changed and any follow-up steps the user should take (e.g. npm install, environment variables).
9. Be direct and technical. No fluff.`;

/**
 * Runs the full agent loop for one user turn, streaming events via onEvent.
 * onEvent receives: { type: 'reasoning'|'tool_call'|'tool_result'|'plan'|'file'|'final'|'usage', ...payload }
 */
export async function runAgentLoop({ history, files, onEvent, signal }) {
  const fsMap = createFSFromFiles(files);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

  let totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  let loopCount = 0;
  const MAX_LOOPS = 12;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    let currentText = "";
    const result = await streamMistralChat({
      messages,
      tools: toolDefinitions,
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

      const execResult = executeTool(call.function.name, args, fsMap);

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
