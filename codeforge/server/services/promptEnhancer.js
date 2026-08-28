import { streamMistralChat } from "./mistralClient.js";

/**
 * Почему "ужасные сайты": в 9 случаях из 10 дело не в модели, а в промпте — пользователь пишет
 * "сделай лендинг покрасивее", модель это понимает буквально и выдаёт дефолтный Bootstrap-вид.
 *
 * Этот шаг прогоняет сырой промпт пользователя через mistral-small-latest ДО того, как он попадёт
 * в основной агентный цикл, и превращает его в конкретное, недвусмысленное техническое задание:
 * добавляет явные требования к дизайну (типографика, сетка, состояния, микро-анимации),
 * уточняет неявные технические детали и убирает двусмысленность — без изменения сути запроса.
 *
 * Быстрая модель (small) + низкий temperature + жёсткий системный промпт держат это дёшево и быстро
 * (обычно <1s), не блокируя ощутимо основной поток.
 */

const ENHANCER_SYSTEM_PROMPT = `You are a prompt-refinement layer sitting in front of an autonomous coding agent.
Your ONLY job: rewrite the user's raw request into a precise, unambiguous technical brief for the agent.

Rules:
1. Preserve the user's actual intent and language (if they wrote in Russian, keep the rewritten brief in Russian).
2. If the request is about UI/visual work (landing page, app, component, "site", "design"), ALWAYS make explicit:
   - concrete visual direction (not "make it beautiful" — pick a direction: typography scale, spacing rhythm, color approach, whether it should feel minimal/bold/editorial/etc, consistent with any existing design tokens if mentioned)
   - required interaction/UX states (hover, focus, loading, empty, error) if relevant
   - responsiveness expectations
3. If the request is ambiguous about scope, pick the most reasonable concrete scope rather than leaving it vague — the agent cannot ask follow-up questions mid-task.
4. Do NOT invent unrelated features. Do NOT pad with fluff. Do NOT explain yourself.
5. Keep it as a single tight paragraph or short bullet list — under ~120 words.
6. Output ONLY the rewritten brief. No preamble, no quotes, no "Here is...".
7. If the input is already precise and technical (e.g. "fix null pointer in parseUser at line 40"), pass it through nearly unchanged — do not over-engineer trivial or already-clear requests.`;

/**
 * @param {string} rawPrompt - the user's original message
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{enhanced: string, original: string, changed: boolean}>}
 */
export async function enhancePrompt(rawPrompt, opts = {}) {
  const original = rawPrompt || "";
  if (!original.trim() || original.trim().length < 6) {
    // Too short to meaningfully enhance (e.g. "ok", "да") — skip the round trip.
    return { enhanced: original, original, changed: false };
  }

  try {
    let text = "";
    await streamMistralChat({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: ENHANCER_SYSTEM_PROMPT },
        { role: "user", content: original }
      ],
      tools: null,
      signal: opts.signal,
      onChunk: (chunk) => {
        if (chunk.type === "content") text += chunk.text;
      }
    });

    const enhanced = text.trim();
    if (!enhanced) return { enhanced: original, original, changed: false };

    return { enhanced, original, changed: enhanced !== original.trim() };
  } catch (err) {
    // Never let enhancement failure block the actual request.
    console.error("promptEnhancer failed, falling back to raw prompt:", err.message);
    return { enhanced: original, original, changed: false };
  }
}
