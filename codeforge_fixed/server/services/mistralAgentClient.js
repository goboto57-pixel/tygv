import fetch from "node-fetch";
import crypto from "crypto";

/**
 * Client for Mistral's stateful Agents + Conversations API, as opposed to
 * the stateless /v1/chat/completions used by mistralClient.js.
 *
 * Why this exists (see conversation with user): the old tool loop resent the
 * ENTIRE growing message history + all ~30 tool schemas on every single
 * loop iteration via /v1/chat/completions — that's what made turns slow and
 * token-hungry compared to the official console/Le Chat, which uses this
 * Agents/Conversations architecture instead:
 *   - POST /v1/agents          -> create an Agent ONCE: model + instructions
 *                                  + tool schemas are stored server-side
 *                                  under an agent_id.
 *   - POST /v1/conversations   -> start a conversation with that agent_id,
 *                                  get back a conversation_id.
 *   - POST /v1/conversations/{id}/messages
 *                               -> append to an existing conversation. You
 *                                  only send the NEW turn (a user message,
 *                                  or a function-result for a pending tool
 *                                  call) — Mistral keeps the full history
 *                                  server-side, so it's not re-sent by us.
 *
 * IMPORTANT — this was written against Mistral's public docs
 * (docs.mistral.ai/studio-api/agents/*) but could not be exercised against
 * a live API key from this environment (no network egress here). Field
 * names below (`inputs`, `outputs`, entry `type`s, `tool_call_id` casing)
 * follow the documented examples as closely as possible; if Mistral responds
 * with a 400 mentioning an unexpected field, that's almost certainly where
 * to look first. agentLoop.js falls back to the old stateless path
 * automatically if any call here throws, so a schema mismatch degrades to
 * "slow but working" rather than breaking the app.
 */

const BASE_URL = "https://api.mistral.ai/v1";

function authHeaders() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY is not configured on the server.");
  // /v1/agents (and chat.completions) accept Authorization: Bearer, but
  // Mistral's own documented curl example for /v1/conversations uses
  // X-API-KEY instead — that mismatch is what caused the 401 (agent
  // creation worked because it only needs Bearer; conversations didn't).
  // Sending both covers whichever the specific endpoint checks.
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "X-API-KEY": apiKey
  };
}

async function postJson(path, body) {
  const apiKey = process.env.MISTRAL_API_KEY;
  const url = `${BASE_URL}${path}`;
  const headers = authHeaders();
  const startedAt = Date.now();

  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (networkErr) {
    // Network-level failure (DNS, TLS, connection refused, timeout) — never
    // silently swallow this, it looks identical to a 401 to the caller
    // otherwise.
    console.error(`[mistralAgentClient] NETWORK ERROR calling POST ${url}`, {
      message: networkErr.message,
      code: networkErr.code,
      cause: networkErr.cause?.message
    });
    throw new Error(`Network error calling ${path}: ${networkErr.message}`);
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const ms = Date.now() - startedAt;

  // Full structured log line — key sent as key_type/length only, never the
  // raw secret, but everything else about the request/response is logged
  // in full so a 401/4xx/5xx can actually be diagnosed instead of guessed at.
  const logPayload = {
    method: "POST",
    url,
    status: res.status,
    ok: res.ok,
    ms,
    requestHeaders: { ...headers, Authorization: headers.Authorization ? "Bearer ***redacted***" : undefined, "X-API-KEY": headers["X-API-KEY"] ? "***redacted***" : undefined },
    apiKeyPresent: !!apiKey,
    apiKeyLength: apiKey ? apiKey.length : 0,
    apiKeyPrefix: apiKey ? apiKey.slice(0, 4) + "…" : null,
    requestBody: body,
    responseHeaders: Object.fromEntries(res.headers.entries()),
    responseBody: data
  };
  if (!res.ok) {
    console.error(`[mistralAgentClient] REQUEST FAILED`, JSON.stringify(logPayload, null, 2));
  } else {
    console.log(`[mistralAgentClient] ${path} -> ${res.status} (${ms}ms)`);
  }

  if (!res.ok) {
    const err = new Error(
      `Mistral API ${path} -> HTTP ${res.status} ${res.statusText || ""}: ${JSON.stringify(data)}`
    );
    err.status = res.status;
    err.detail = logPayload;
    throw err;
  }
  return data;
}

// In-memory cache: one Agent per distinct (model + instructions + tool set +
// reasoning effort) combination. Re-creating an Agent object for a config we
// already registered would be wasteful and would also spawn a new agent_id
// server-side every server restart with no benefit, so we key on a hash of
// the config. This is process-memory only (not persisted to disk/Cloudinary)
// — a server restart re-creates agents on demand, which costs one extra
// call the first time each config is used again, not a correctness issue.
const agentCache = new Map(); // hash -> agent_id

function hashAgentConfig({ model, instructions, tools, reasoningEffort }) {
  const h = crypto.createHash("sha1");
  h.update(model || "");
  h.update("|" + (instructions || ""));
  h.update("|" + (reasoningEffort || "none"));
  h.update("|" + JSON.stringify((tools || []).map((t) => t.function?.name || t.type).sort()));
  return h.digest("hex");
}

/**
 * Returns a cached agent_id for this exact config, creating the Agent on
 * Mistral's side the first time this config is seen.
 */
export async function ensureAgent({ model, instructions, tools, reasoningEffort }) {
  const key = hashAgentConfig({ model, instructions, tools, reasoningEffort });
  if (agentCache.has(key)) return agentCache.get(key);

  const body = {
    model,
    name: `codeforge-${key.slice(0, 10)}`,
    description: "CodeForge coding agent (auto-managed, do not edit in Studio — recreated on config change).",
    instructions,
    tools: tools && tools.length ? tools : undefined,
    completion_args: {
      temperature: 0.2,
      ...(reasoningEffort && reasoningEffort !== "none" ? { reasoning_effort: reasoningEffort } : {})
    }
  };

  const data = await postJson("/agents", body);
  const agentId = data.id || data.agent_id;
  if (!agentId) throw new Error("Mistral Agents API did not return an agent id.");
  agentCache.set(key, agentId);
  return agentId;
}

/**
 * Starts a brand-new conversation with an agent, sending the first user
 * input. Returns { conversationId, outputs } where outputs is the raw
 * `outputs` array from Mistral (message.output / function.call entries).
 */
export async function startConversation({ agentId, inputs }) {
  const data = await postJson("/conversations", { agent_id: agentId, inputs, store: true });
  const conversationId = data.conversation_id || data.id;
  if (!conversationId) throw new Error("Mistral Conversations API did not return a conversation id.");
  return { conversationId, outputs: data.outputs || [] };
}

/**
 * Appends to an existing conversation — either a new user message, or one
 * or more function-result entries answering pending tool calls. Only the
 * delta is sent; Mistral keeps the rest of the history server-side.
 */
export async function appendConversation({ conversationId, inputs }) {
  const data = await postJson(`/conversations/${conversationId}/messages`, { inputs });
  return { outputs: data.outputs || [] };
}

/**
 * Normalizes one output entry from the Conversations API into the shape the
 * rest of agentLoop.js already knows how to handle (mirrors the
 * chat-completions tool_call shape: { id, function: { name, arguments } }).
 */
export function extractFunctionCalls(outputs) {
  return (outputs || [])
    .filter((o) => o.type === "function.call")
    .map((o) => ({
      id: o.tool_call_id || o.id,
      function: { name: o.name, arguments: typeof o.arguments === "string" ? o.arguments : JSON.stringify(o.arguments || {}) }
    }));
}

export function extractText(outputs) {
  return (outputs || [])
    .filter((o) => o.type === "message.output")
    .map((o) => (typeof o.content === "string" ? o.content : (o.content || []).map((c) => c.text || "").join("")))
    .join("");
}
