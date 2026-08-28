/**
 * Bridges the SSE-streaming agent loop and a separate REST call the
 * frontend makes when the user clicks Approve/Reject on a pending diff.
 *
 * The agent loop (agentLoop.js) is a single long-lived request/response —
 * it can't itself "wait for a click" without something outside it to
 * signal when that click happened. So: when a diff needs approval, the
 * loop registers a Promise here keyed by a token, emits an SSE event
 * containing that token, and awaits the Promise. The separate
 * POST /chat/approve/:token route (see chat.js) resolves it.
 *
 * In-memory only — fine for a single-process deployment where the
 * streaming request and the approval click land on the same server
 * instance. Entries are one-shot and self-cleaning (resolved once,
 * deleted immediately after).
 */
const pending = new Map(); // token -> { resolve, timeout, resolved }

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — long enough for a user to actually look at a diff

function makeToken() {
  return `apr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Registers a new pending approval and returns { token, promise }.
 * `promise` resolves to `true`/`false` once resolveApproval(token, ...) is
 * called, or resolves to `false` automatically after APPROVAL_TIMEOUT_MS so
 * a user who never comes back doesn't hang the agent loop forever.
 */
export function createPendingApproval() {
  const token = makeToken();
  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  const timeout = setTimeout(() => {
    resolveApproval(token, false);
  }, APPROVAL_TIMEOUT_MS);
  pending.set(token, { resolve: resolveFn, timeout, resolved: false });
  return { token, promise };
}

export function resolveApproval(token, approved, note) {
  const entry = pending.get(token);
  if (!entry || entry.resolved) return false;
  entry.resolved = true;
  clearTimeout(entry.timeout);
  pending.delete(token);
  // Resolve with both the decision and any free-text note so the agent can
  // adapt the plan/change when the user rejected with feedback.
  entry.resolve({ approved: !!approved, note: note || "" });
  return true;
}

export function hasPending(token) {
  const entry = pending.get(token);
  return !!entry && !entry.resolved;
}
