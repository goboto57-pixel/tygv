import fetch from "node-fetch";
import FormData from "form-data";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

// Только реально поддерживаемые модели Mistral могут быть выбраны с клиента.
const ALLOWED_MODELS = new Set([
  "codestral-latest",
  "devstral-medium-latest",
  "mistral-large-latest",
  "mistral-medium-latest",
  "mistral-small-latest",
  "pixtral-large-latest"
]);

// Model forced for any turn that includes image attachments (design
// screenshots, etc). Pixtral supports both vision and tool calling, so the
// agent loop can keep using file tools while reasoning about the image.
export const VISION_MODEL = "pixtral-large-latest";

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

  // Watchdog: if the stream stalls (dead connection, provider hang), the
  // fetch above never rejects on its own — signal only fires on explicit
  // user cancellation. Without this, "agent thinking forever" is often just
  // a hung TCP stream nobody ever aborts. Layer our own timeout on top of
  // whatever `signal` the caller passed in.
  const STREAM_TIMEOUT_MS = 90_000;
  const watchdog = new AbortController();
  let timeoutId = setTimeout(() => watchdog.abort(), STREAM_TIMEOUT_MS);
  const resetTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => watchdog.abort(), STREAM_TIMEOUT_MS);
  };
  if (signal) {
    if (signal.aborted) watchdog.abort();
    else signal.addEventListener("abort", () => watchdog.abort(), { once: true });
  }

  let response;
  const maxAttempts = 6;
  // helper to compute backoff with jitter and respect Retry-After
  const backoffDelay = (attempt, retryAfter) => {
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!isNaN(secs) && secs > 0 && secs < 120) return secs * 1000;
      const date = Date.parse(retryAfter);
      if (!isNaN(date)) return Math.max(0, date - Date.now());
    }
    const base = 1200;
    const exp = base * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 400);
    return Math.min(exp + jitter, 30000);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: watchdog.signal
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError" && !(signal && signal.aborted)) {
        throw new Error(`Mistral API timed out after ${STREAM_TIMEOUT_MS / 1000}s (no response). The model or connection may have stalled — try again.`);
      }
      if (err.name !== "AbortError" && attempt < maxAttempts) {
        const delay = backoffDelay(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        timeoutId = setTimeout(() => watchdog.abort(), STREAM_TIMEOUT_MS);
        continue;
      }
      throw err;
    }

    if (response.ok) break;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const isRateLimit = response.status === 429;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = response.headers?.get?.("retry-after");
      try { await response.arrayBuffer(); } catch {}
      // rate limits get longer backoff
      const delay = backoffDelay(attempt + (isRateLimit ? 1 : 0), retryAfter);
      await new Promise((resolve) => setTimeout(resolve, delay));
      resetTimeout();
      continue;
    }
    break;
  }

  if (!response?.ok) {
    clearTimeout(timeoutId);
    const errText = await response?.text();
    throw new Error(`Mistral API error ${response?.status || "unknown"}: ${errText || "request failed"}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulators for a possible tool call being streamed in pieces
  let accumulatedToolCalls = {};
  let accumulatedContent = "";
  let finishReason = null;
  let usage = null;

  try {
  for await (const chunk of response.body) {
    // Any byte received resets the watchdog — we only want to kill truly
    // stalled connections, not long-but-actively-streaming responses.
    resetTimeout();
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
    // Do not lose the last SSE frame when the provider closes without a final newline.
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:") && trimmed.replace(/^data:\s*/, "") !== "[DONE]") {
        try {
          const parsed = JSON.parse(trimmed.replace(/^data:\s*/, ""));
          const choice = parsed.choices?.[0];
          const delta = choice?.delta || {};
          if (delta.content) { accumulatedContent += delta.content; onChunk({ type: "content", text: delta.content }); }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulatedToolCalls[idx]) accumulatedToolCalls[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
              if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (parsed.usage) usage = parsed.usage;
        } catch {}
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const toolCalls = Object.values(accumulatedToolCalls);

  return {
    content: accumulatedContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    finishReason,
    usage
  };
}

/**
 * Transcribes an audio buffer (voice prompt input) using Mistral's Voxtral
 * transcription model.
 */
export async function transcribeAudio({ buffer, filename, mimeType }) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not configured on the server.");
  }

  const form = new FormData();
  form.append("model", process.env.MISTRAL_VOICE_MODEL || "voxtral-mini-latest");
  form.append("file", buffer, { filename: filename || "voice-input.webm", contentType: mimeType || "audio/webm" });

  const response = await fetch(MISTRAL_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...form.getHeaders()
    },
    body: form
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral transcription error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return { text: (data.text || "").trim() };
}

const MISTRAL_EMBEDDINGS_URL = "https://api.mistral.ai/v1/embeddings";

/**
 * Batched embeddings via Mistral's embedding model, used for semantic code
 * search (see projectFS.js -> semantic_search tool). Mistral's endpoint
 * accepts an array of inputs per call, so we chunk to stay well under any
 * request-size limits rather than firing one request per snippet.
 */
export async function embedTexts(texts) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not configured on the server.");
  }
  if (!texts || texts.length === 0) return [];

  const BATCH = 96;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    let response;
    // embeddings retry with backoff (lighter than chat)
    for (let attempt = 1; attempt <= 4; attempt++) {
      response = await fetch(MISTRAL_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.MISTRAL_EMBED_MODEL || "mistral-embed",
          input: batch
        })
      });
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 4) {
        const ra = response.headers?.get?.("retry-after");
        let delay = 800 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);
        if (ra) {
          const secs = parseInt(ra, 10);
          if (!isNaN(secs)) delay = Math.max(delay, secs * 1000);
        }
        try { await response.text(); } catch {}
        await new Promise((r) => setTimeout(r, Math.min(delay, 15000)));
        continue;
      }
      break;
    }
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Mistral embeddings error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    const sorted = (data.data || []).sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}
