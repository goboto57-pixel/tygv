import fetch from "node-fetch";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

// Только реально поддерживаемые модели Mistral могут быть выбраны с клиента.
const ALLOWED_MODELS = new Set([
  "codestral-latest",
  "devstral-medium-latest",
  "mistral-large-latest",
  "mistral-medium-latest",
  "mistral-small-latest"
]);

/**
 * Streams a chat completion from Mistral Codestral.
 * Emits parsed SSE chunks via onChunk callback.
 * Supports tool calling.
 */
export async function streamMistralChat({ messages, tools, model, onChunk, signal }) {
  const apiKey = process.env.MISTRAL_API_KEY;
  const defaultModel = process.env.MISTRAL_MODEL || "codestral-latest";
  const resolvedModel = model && ALLOWED_MODELS.has(model) ? model : defaultModel;

  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not configured on the server.");
  }

  const body = {
    model: resolvedModel,
    messages,
    stream: true,
    temperature: 0.2,
    max_tokens: 8000
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = await fetch(MISTRAL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${errText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulators for a possible tool call being streamed in pieces
  let accumulatedToolCalls = {};
  let accumulatedContent = "";
  let finishReason = null;
  let usage = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.replace(/^data:\s*/, "");
      if (data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta || {};

      if (delta.content) {
        accumulatedContent += delta.content;
        onChunk({ type: "content", text: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!accumulatedToolCalls[idx]) {
            accumulatedToolCalls[idx] = {
              id: tc.id || `call_${idx}`,
              type: "function",
              function: { name: "", arguments: "" }
            };
          }
          if (tc.function?.name) {
            accumulatedToolCalls[idx].function.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (parsed.usage) {
        usage = parsed.usage;
      }
    }
  }

  const toolCalls = Object.values(accumulatedToolCalls);

  return {
    content: accumulatedContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    finishReason,
    usage
  };
}
