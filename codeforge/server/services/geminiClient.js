import fetch from "node-fetch";

// Google Generative Language API (Gemini). Uses streamGenerateContent (SSE-like JSON array streaming).
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ALLOWED_GEMINI_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash"
]);

/**
 * Converts our OpenAI-style tool definitions ({type:"function", function:{name, description, parameters}})
 * into Gemini's functionDeclarations format.
 */
function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }
  ];
}

/**
 * Converts OpenAI-style chat messages (system/user/assistant/tool) into Gemini's
 * {role, parts:[...]} contents array. System messages become a systemInstruction.
 */
function toGeminiContents(messages) {
  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemInstruction = { parts: [{ text: msg.content }] };
      continue;
    }
    if (msg.role === "user") {
      contents.push({ role: "user", parts: [{ text: msg.content ?? "" }] });
      continue;
    }
    if (msg.role === "assistant") {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    if (msg.role === "tool") {
      let responsePayload;
      try {
        responsePayload = JSON.parse(msg.content);
      } catch {
        responsePayload = { result: msg.content };
      }
      contents.push({
        role: "function",
        parts: [{ functionResponse: { name: msg.name, response: responsePayload } }]
      });
      continue;
    }
  }

  return { systemInstruction, contents };
}

/**
 * Streams a chat completion from Gemini, normalized to the same shape as streamMistralChat:
 * { content, toolCalls, finishReason, usage }
 */
export async function streamGeminiChat({ messages, tools, model, onChunk, signal }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  const resolvedModel = model && ALLOWED_GEMINI_MODELS.has(model) ? model : "gemini-2.5-pro";

  const { systemInstruction, contents } = toGeminiContents(messages);
  const body = {
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 8000 }
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;

  const url = `${GEMINI_API_BASE}/${resolvedModel}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedContent = "";
  const accumulatedCalls = [];
  let usage = null;
  let finishReason = null;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.replace(/^data:\s*/, "");
      if (!data || data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const cand = parsed.candidates?.[0];
      if (!cand) continue;
      if (cand.finishReason) finishReason = cand.finishReason;

      for (const part of cand.content?.parts || []) {
        if (part.text) {
          accumulatedContent += part.text;
          onChunk({ type: "content", text: part.text });
        }
        if (part.functionCall) {
          accumulatedCalls.push({
            id: `call_${accumulatedCalls.length}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {})
            }
          });
        }
      }

      if (parsed.usageMetadata) {
        usage = {
          prompt_tokens: parsed.usageMetadata.promptTokenCount || 0,
          completion_tokens: parsed.usageMetadata.candidatesTokenCount || 0
        };
      }
    }
  }

  return {
    content: accumulatedContent,
    toolCalls: accumulatedCalls.length > 0 ? accumulatedCalls : null,
    finishReason,
    usage
  };
}

/**
 * One-shot, non-streaming Gemini call — used for quick analysis/decision steps (council mode)
 * where we just need a text answer, not a full agent turn.
 */
export async function geminiQuickAnswer({ prompt, model = "gemini-2.5-flash" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
  const resolvedModel = ALLOWED_GEMINI_MODELS.has(model) ? model : "gemini-2.5-flash";
  const url = `${GEMINI_API_BASE}/${resolvedModel}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}
