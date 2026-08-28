import fetch from "node-fetch";

// Google Generative Language API (Gemini). Uses streamGenerateContent (SSE-like JSON array streaming).
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const ALLOWED_GEMINI_MODELS = new Set([
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview"
]);

const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
const DEFAULT_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || "low";
const GEMINI_STREAM_TIMEOUT_MS = Number(process.env.GEMINI_STREAM_TIMEOUT_MS || 90000);

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
      const text = Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("\n") : msg.content;
      if (systemInstruction) {
        // Concatenate multiple system messages instead of overwriting
        systemInstruction.parts[0].text += "\n\n" + text;
      } else {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }
    if (msg.role === "user") {
      // Handle multimodal content (text + image_url parts) - extract text only for Gemini
      const text = Array.isArray(msg.content) ? msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : (msg.content ?? "");
      contents.push({ role: "user", parts: [{ text }] });
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
        role: "user",
        parts: [{ functionResponse: { name: msg.name, id: msg.tool_call_id, response: responsePayload } }]
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
export async function streamGeminiChat({ messages, tools, model, onChunk, signal, thinkingLevel = DEFAULT_THINKING_LEVEL }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  const resolvedModel = model && ALLOWED_GEMINI_MODELS.has(model) ? model : DEFAULT_GEMINI_MODEL;

  const { systemInstruction, contents } = toGeminiContents(messages);
  const isThinkingModel = resolvedModel.includes("3.5") || resolvedModel.includes("3.1") || resolvedModel.includes("2.5");
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: 8000,
      ...(isThinkingModel ? { thinkingConfig: { thinkingLevel: ["low", "medium", "high"].includes(thinkingLevel) ? thinkingLevel : DEFAULT_THINKING_LEVEL } } : {})
    }
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const geminiTools = toGeminiTools(tools);
  if (geminiTools) body.tools = geminiTools;

  const url = `${GEMINI_API_BASE}/${resolvedModel}:streamGenerateContent?alt=sse`;

  // A provider can occasionally leave a streaming request open without
  // producing any bytes. Use a watchdog so the agent never appears to be
  // "thinking forever"; any received byte resets the timer.
  const watchdog = new AbortController();
  let timeoutId = setTimeout(() => watchdog.abort(), GEMINI_STREAM_TIMEOUT_MS);
  const resetTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => watchdog.abort(), GEMINI_STREAM_TIMEOUT_MS);
  };
  if (signal) {
    if (signal.aborted) watchdog.abort();
    else signal.addEventListener("abort", () => watchdog.abort(), { once: true });
  }

  let response;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: watchdog.signal
      });
    } catch (err) {
      if (err.name === "AbortError" && !(signal && signal.aborted)) {
        clearTimeout(timeoutId);
        throw new Error(`Gemini API timed out after ${GEMINI_STREAM_TIMEOUT_MS / 1000}s.`);
      }
      if (err.name !== "AbortError" && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        resetTimeout();
        continue;
      }
      clearTimeout(timeoutId);
      throw err;
    }

    if (response.ok) break;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      try { await response.arrayBuffer(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      resetTimeout();
      continue;
    }
    break;
  }

  if (!response?.ok) {
    clearTimeout(timeoutId);
    const errText = await response?.text();
    throw new Error(`Gemini API error ${response?.status || "unknown"}: ${errText || "request failed"}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedContent = "";
  const accumulatedCalls = [];
  let usage = null;
  let finishReason = null;

  try {
    for await (const chunk of response.body) {
      resetTimeout();
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
              id: part.functionCall.id || `call_${accumulatedCalls.length}`,
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
    // Some proxies/providers may close the stream without a trailing newline.
    // Process the last buffered SSE frame instead of silently dropping it.
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        try {
          const parsed = JSON.parse(trimmed.replace(/^data:\s*/, ""));
          const cand = parsed.candidates?.[0];
          for (const part of cand?.content?.parts || []) {
            if (part.text) { accumulatedContent += part.text; onChunk({ type: "content", text: part.text }); }
            if (part.functionCall) accumulatedCalls.push({ id: part.functionCall.id || `call_${accumulatedCalls.length}`, type: "function", function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } });
          }
          if (parsed.usageMetadata) usage = { prompt_tokens: parsed.usageMetadata.promptTokenCount || 0, completion_tokens: parsed.usageMetadata.candidatesTokenCount || 0 };
        } catch {}
      }
    }
  } finally {
    clearTimeout(timeoutId);
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
export async function geminiQuickAnswer({ prompt, model = "gemini-3.6-flash", thinkingLevel = "low" }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
  const resolvedModel = ALLOWED_GEMINI_MODELS.has(model) ? model : "gemini-3.6-flash";
  const url = `${GEMINI_API_BASE}/${resolvedModel}:generateContent`;

  const isQuickThinking = resolvedModel.includes("3.5") || resolvedModel.includes("3.1") || resolvedModel.includes("2.5");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 1200,
        ...(isQuickThinking ? { thinkingConfig: { thinkingLevel: ["low", "medium", "high"].includes(thinkingLevel) ? thinkingLevel : "low" } } : {})
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
}
