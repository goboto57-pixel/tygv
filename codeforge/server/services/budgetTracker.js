/**
 * Tracks token/time spend during one agent-loop run and emits warning
 * events as thresholds are crossed, so the UI can show the user something
 * is getting expensive/long BEFORE the loop finishes or hits MAX_LOOPS,
 * not after.
 *
 * Hard limits (tokenHard, timeHardMs) indicate the run should be aborted
 * to prevent runaway costs. The caller is responsible for checking the
 * `exceeded` flag and terminating the loop.
 */

// Defaults are generous on purpose — these exist to catch genuinely
// runaway turns (stuck in a tool-call loop, huge context re-sent every
// iteration), not to nag on every normal multi-file task.
const DEFAULT_LIMITS = {
  tokenWarn: 60_000,
  tokenHard: 150_000,
  timeWarnMs: 90_000,
  timeHardMs: 240_000
};

export function createBudgetTracker(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const startedAt = Date.now();
  let totalTokens = 0;
  const warned = new Set();
  const perTool = new Map(); // tool -> count
  function addUsage(usage) {
    if (!usage) return;
    totalTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  }
  function addToolCall(name) {
    perTool.set(name, (perTool.get(name) || 0) + 1);
  }

  /**
   * Call after each loop iteration. Returns a warning event to emit, or
   * null if nothing crossed a threshold since the last check. Each
   * threshold only fires once per run (tracked via `warned`).
   * The returned object includes `exceeded: true` if a hard limit was crossed.
   */
  function check() {
    const elapsedMs = Date.now() - startedAt;
    // per-tool spam: if any tool called >12 times, warn
    for (const [tool, cnt] of perTool.entries()) {
      if (cnt > 12 && !warned.has(`tool-${tool}`)) {
        warned.add(`tool-${tool}`);
        return { level: "warn", kind: "tool", tool, value: cnt, limit: 12, exceeded: false };
      }
    }
    if (totalTokens >= limits.tokenHard && !warned.has("token-hard")) {
      warned.add("token-hard");
      return { level: "hard", kind: "tokens", value: totalTokens, limit: limits.tokenHard, exceeded: true };
    }
    if (elapsedMs >= limits.timeHardMs && !warned.has("time-hard")) {
      warned.add("time-hard");
      return { level: "hard", kind: "time", value: elapsedMs, limit: limits.timeHardMs, exceeded: true };
    }
    if (totalTokens >= limits.tokenWarn && !warned.has("token-warn")) {
      warned.add("token-warn");
      return { level: "warn", kind: "tokens", value: totalTokens, limit: limits.tokenWarn, exceeded: false };
    }
    if (elapsedMs >= limits.timeWarnMs && !warned.has("time-warn")) {
      warned.add("time-warn");
      return { level: "warn", kind: "time", value: elapsedMs, limit: limits.timeWarnMs, exceeded: false };
    }
    return null;
  }

  function snapshot() {
    return { totalTokens, elapsedMs: Date.now() - startedAt, limits, perTool: Object.fromEntries(perTool) };
  }

  function isExceeded() {
    const elapsedMs = Date.now() - startedAt;
    return totalTokens >= limits.tokenHard || elapsedMs >= limits.timeHardMs;
  }

  return { addUsage, addToolCall, check, snapshot, isExceeded };
}
