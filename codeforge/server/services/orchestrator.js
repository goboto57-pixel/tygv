import { streamMistralChat } from "./mistralClient.js";
import { geminiQuickAnswer } from "./geminiClient.js";

/**
 * COUNCIL MODE
 * Gemini 2.5 Pro and Mistral Large independently analyze the task, then Mistral Large
 * reads both takes and produces one merged decision (approach + concrete plan) that
 * the main agent loop is seeded with. Runs the two "opinions" in parallel for latency.
 */
export async function runCouncil({ taskText, projectSummary }) {
  const analysisPrompt = `Task from the user:\n"""${taskText}"""\n\nProject context:\n${projectSummary || "(empty project)"}\n\nGive a short technical analysis (max ~120 words): what's the best approach, what could go wrong, what should be prioritized. Be concrete and opinionated, not generic.`;

  const [geminiView, mistralView] = await Promise.allSettled([
    geminiQuickAnswer({ prompt: analysisPrompt, model: "gemini-3.7-flash" }),
    quickMistralAnswer(analysisPrompt, "mistral-large-latest")
  ]);

  const geminiText =
    geminiView.status === "fulfilled" ? geminiView.value : `(Gemini недоступен: ${geminiView.reason?.message || "ошибка"})`;
  const mistralText =
    mistralView.status === "fulfilled" ? mistralView.value : `(Mistral недоступен: ${mistralView.reason?.message || "ошибка"})`;

  const synthesisPrompt = `Two AI analyses of the same coding task are below. Reconcile them into ONE decisive, concrete plan of action (bullet points, max ~10 lines). Where they disagree, pick the stronger technical argument and briefly say why in one clause. Don't mention "Gemini" or "Mistral" by name in the output — just give the final plan as if you decided it yourself.\n\n--- Analysis A ---\n${geminiText}\n\n--- Analysis B ---\n${mistralText}`;

  const decision = await quickMistralAnswer(synthesisPrompt, "mistral-large-latest");

  return { geminiText, mistralText, decision };
}

async function quickMistralAnswer(prompt, model) {
  let text = "";
  await streamMistralChat({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: null,
    onChunk: (chunk) => {
      if (chunk.type === "content") text += chunk.text;
    }
  });
  return text.trim();
}

/**
 * COLLAB MODE tool definition: Mistral Large (the "chair") can delegate a well-scoped
 * sub-task to a Devstral subagent, which runs its OWN short tool-use loop against the
 * same project file system and returns a summary of what it changed. This lets Large
 * stay focused on architecture/coordination while Devstral does the mechanical edits.
 */
export const delegateSubagentTool = {
  type: "function",
  function: {
    name: "delegate_to_subagent",
    description:
      "Delegate a specific, well-scoped implementation sub-task to a Devstral subagent (fast, strong at focused code edits). Use this to parallelize/split large tasks instead of doing every file yourself. The subagent has access to the same project files and file tools, and returns a short report of what it did.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Precise, self-contained instructions for the subagent." },
        relevant_files: {
          type: "array",
          items: { type: "string" },
          description: "Paths the subagent should look at first (optional but recommended)."
        }
      },
      required: ["task"]
    }
  }
};

/**
 * Runs a bounded sub-loop for the delegated subagent (mistral-devstral), reusing the
 * same tool-execution machinery as the main loop. Returns a short text report.
 */
export async function runSubagent({ task, relevantFiles, fsMap, toolDefinitions, executeTool, onEvent, signal }) {
  const sys = `You are a focused implementation subagent (Devstral) working inside a larger project. You were delegated this sub-task by a lead agent:\n"""${task}"""\n${
    relevantFiles?.length ? `Relevant files to start with: ${relevantFiles.join(", ")}` : ""
  }\nUse the available tools to read what you need and make the necessary edits directly (write_file/edit_file). When done, reply with plain text summarizing exactly what you changed — no further tool calls after that. Keep the whole sub-task under 6 tool calls.`;

  const messages = [{ role: "system", content: sys }, { role: "user", content: task }];
  let loops = 0;
  const MAX_SUB_LOOPS = 6;

  while (loops < MAX_SUB_LOOPS) {
    loops++;
    let text = "";
    const result = await streamMistralChat({
      model: "devstral-medium-latest",
      messages,
      tools: toolDefinitions,
      signal,
      onChunk: (chunk) => {
        if (chunk.type === "content") text += chunk.text;
      }
    });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return result.content || text || "Subagent finished (no summary text).";
    }

    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const execResult = await executeTool(call.function.name, args, fsMap);
      if (execResult.fileChanged) {
        onEvent?.({ type: "file", path: execResult.fileChanged, content: fsMap.get(execResult.fileChanged), subagent: true });
      }
      if (execResult.filesChanged && execResult.filesChanged.length) {
        for (const p of execResult.filesChanged) {
          onEvent?.({ type: "file", path: p, content: fsMap.get(p), subagent: true });
        }
      }
      onEvent?.({ type: "tool_call", name: call.function.name, args, subagent: true });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(execResult.error ? { error: execResult.error } : execResult.result)
      });
    }
  }

  return "Subagent reached its sub-task tool-call limit; work may be partial.";
}
