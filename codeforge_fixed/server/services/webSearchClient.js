import fetch from "node-fetch";

const CONVERSATIONS_URL = "https://api.mistral.ai/v1/conversations";

/**
 * Web Search / Premium Search built-in connectors.
 *
 * Per docs.mistral.ai/studio-api/agents/agent-tools: `web_search` and
 * `web_search_premium` only work through the Conversations API
 * (/v1/conversations) or the Agents API — they are NOT accepted by
 * /v1/chat/completions, which is what the rest of this app (agentLoop /
 * mistralClient) uses for the normal coding tool-loop. So "search modes"
 * get their own small non-streaming call here instead of being bolted onto
 * streamMistralChat's tools array (which would silently be ignored by the
 * API for these two tool types).
 *
 * Returns { text, citations } where citations is a best-effort list of
 * { title, url } pulled from any tool_reference chunks in the response.
 */
export async function runMistralWebSearch({ query, premium = false, model = "mistral-medium-latest" }) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error("MISTRAL_API_KEY is not configured on the server.");
  }

  const body = {
    model,
    inputs: query,
    tools: [{ type: premium ? "web_search_premium" : "web_search" }],
    completion_args: { temperature: 0.3 }
  };

  const response = await fetch(CONVERSATIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral Conversations API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const outputs = data.outputs || [];

  let text = "";
  const citations = [];
  for (const out of outputs) {
    if (out.type === "message.output" && Array.isArray(out.content)) {
      for (const chunk of out.content) {
        if (chunk.type === "text") text += chunk.text;
        if (chunk.type === "tool_reference" && (chunk.url || chunk.title)) {
          citations.push({ title: chunk.title || chunk.url, url: chunk.url });
        }
      }
    } else if (out.type === "message.output" && typeof out.content === "string") {
      text += out.content;
    }
  }

  return { text: text.trim(), citations };
}
