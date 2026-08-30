import fetch from "node-fetch";

// Cloudflare Workers AI — OpenAI-compatible endpoint (/ai/v1/chat/completions),
// so unlike Gemini this does NOT need a custom message/tool-schema translator:
// it accepts the exact same {role, content, tool_calls}/{type:"function",...}
// shapes streamMistralChat already builds. See:
// https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts";

// @cf/qwen/qwen3-30b-a3b-fp8: MoE (30B total / 3B active params), 32K context,
// supports function calling + reasoning. https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/
export const CLOUDFLARE_MODEL_CATALOG = [
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B A3B (FP8)",
    group: "Cloudflare",
    vision: false,
    reasoning: false,
    desc: "MoE-модель Alibaba (30B/3B активных параметров) на Cloudflare Workers AI — быстрый инференс, поддерживает function calling. Контекст 32K, так что держите проект компактным."
  }
];

const ALLOWED_CLOUDFLARE_MODELS = new Set(CLOUDFLARE_MODEL_CATALOG.map((m) => m.id));
const DEFAULT_CLOUDFLARE_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

// 32K total context (input + output combined) — much smaller than Mistral's
// window, so the output cap has to leave real room for the prompt itself.
// Callers should keep requests reasonably small; we additionally hard-cap
// completion tokens here regardless of what taskComplexity.js would give a
// bigger-context model, so a large prompt can't push the request over the
// model's own window and get truncated/rejected.
const CLOUDFLARE_MAX_COMPLETION_TOKENS = 6000;
const CLOUDFLARE_STREAM_TIMEOUT_MS = Number(process.env.CLOUDFLARE_STREAM_TIMEOUT_MS || 90000);

export function isCloudflareModel(model) {
  return typeof model === "string" && model.startsWith("@cf/");
}

/**
 * Streams a chat completion from Cloudflare Workers AI, normalized to the
 * same shape as streamMistralChat: { content, toolCalls, finishReason, usage }.
 */
export async function streamCloudflareChat({ messages, tools, model, onChunk, signal, maxTokens }) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN is not configured on the server.");
  }

  const resolvedModel = model && ALLOWED_CLOUDFLARE_MODELS.has(model) ? model : DEFAULT_CLOUDFLARE_MODEL;
  const url = `${CLOUDFLARE_API_BASE}/${accountId}/ai/v1/chat/completions`;

  const body = {
    model: resolvedModel,
    messages,
    stream: true,
    temperature: 0.2,
    max_tokens: Math.min(maxTokens || CLOUDFLARE_MAX_COMPLETION_TOKENS, CLOUDFLARE_MAX_COMPLETION_TOKENS)
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const watchdog = new AbortController();
  let timeoutId = setTimeout(() => watchdog.abort(), CLOUDFLARE_STREAM_TIMEOUT_MS);
  const resetTimeout = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => watchdog.abort(), CLOUDFLARE_STREAM_TIMEOUT_MS);
  };
  if (signal) {
    if (signal.aborted) watchdog.abort();
    else signal.addEventListener("abort", () => watchdog.abort(), { once: true });
  }

  let response;
  const maxAttempts = 6;
  const backoffDelay = (attempt, retryAfter) => {
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (!isNaN(secs) && secs > 0 && secs < 120) return secs * 1000;
    }
    const base = 1200;
    const exp = base * Math.pow(2, attempt - 1);
    return Math.min(exp + Math.floor(Math.random() * 400), 30000);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify(body),
        signal: watchdog.signal
      });
    } catch (err) {
      if (err.name === "AbortError" && !(signal && signal.aborted)) {
        clearTimeout(timeoutId);
        throw new Error(`Cloudflare Workers AI timed out after ${CLOUDFLARE_STREAM_TIMEOUT_MS / 1000}s.`);
      }
      if (err.name !== "AbortError" && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
        timeoutId = setTimeout(() => watchdog.abort(), CLOUDFLARE_STREAM_TIMEOUT_MS);
        continue;
      }
      clearTimeout(timeoutId);
      throw err;
    }

    if (response.ok) break;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = response.headers?.get?.("retry-after");
      try { await response.arrayBuffer(); } catch {}
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, retryAfter)));
      resetTimeout();
      continue;
    }
    break;
  }

  if (!response?.ok) {
    clearTimeout(timeoutId);
    const errText = await response?.text();
    throw new Error(`Cloudflare Workers AI error ${response?.status || "unknown"}: ${errText || "request failed"}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedContent = "";
  let accumulatedToolCalls = {};
  let finishReason = null;
  let usage = null;

  const applyDelta = (delta) => {
    if (!delta) return;
    if (delta.content) {
      accumulatedContent += delta.content;
      onChunk({ type: "content", text: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!accumulatedToolCalls[idx]) {
          accumulatedToolCalls[idx] = { id: tc.id || `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
        }
        if (tc.id) accumulatedToolCalls[idx].id = tc.id;
        if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  };

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
        try { parsed = JSON.parse(data); } catch { continue; }

        const choice = parsed.choices?.[0];
        if (choice?.delta) applyDelta(choice.delta);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (parsed.usage) {
          usage = {
            prompt_tokens: parsed.usage.prompt_tokens || 0,
            completion_tokens: parsed.usage.completion_tokens || 0
          };
        }
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
