
## v5 backend intelligence/speed pass (server only, client untouched)
- **Real parallelism bug fix**: `lint_files` (batch) and `web_search` were missing from `READ_ONLY_TOOLS` in `toolExecution.js`, so they were being scheduled as "ordered/mutating" calls — forced to run sequentially even when requested alongside other independent reads in the same turn. Now correctly parallelized like every other read-only tool. `outline_file` (new, see below) added to the same set.
- **Smarter task-complexity classifier** (`taskComplexity.js`, the single source of truth `getMaxLoops`/`getMaxTokens` both derive from): added a `trivial` tier below `fix` for one-clause tweaks, a structural signal (backend/API/auth/database keywords bump the tier even when the wording sounds small — "поправь баг в авторизации" now correctly gets more budget than a plain UI fix), and a multi-request signal (numbered/bulleted lists, "также добавь…", "and also…" bump the tier since multi-part asks reliably run out of loop budget the most). Also fixed a real bug introduced during this pass: `\b` word-boundary regex anchors don't work around Cyrillic text in JS (`\w` only covers `[A-Za-z0-9_]`), which would have silently broken every Cyrillic pattern — caught by a standalone test before shipping.
- **New tool: `outline_file`** — returns a file's top-level function/class/component signatures with line numbers instead of its full body. Lets the agent locate what it needs in a large file for a fraction of the token cost of `read_file`, instead of reading the whole thing just to find one function. Covers JS/TS/JSX, Python, and CSS rule selectors. Wired through `toolDefinitions.js`, `projectFS.js` (`executeTool`), and `toolExecution.js` (read-only, so it parallelizes with other reads).
- System prompt (`agentLoop.js`): added explicit guidance to reach for `outline_file` before a full `read_file` on suspected-large files, and to batch multiple edits to the *same* file into one `apply_patch` call instead of several sequential `edit_file` calls.
- Added regression tests (`stability.test.js`) covering the read-only-scheduling fix and the classifier's tier/budget monotonicity. `node --test` now passes 4/4 (was 2/2).
- Cross-checked that every tool in `toolDefinitions.js` has a matching implementation in `projectFS.js`'s `executeTool` (or is handled specially in `agentLoop.js`, like `save_memory`/`delegate_to_subagent`) — no orphaned tool definitions.

## Full audit / v3 stability update
- Fixed final-response persistence using a live messages ref; no more stale-closure saves after streaming.
- Added pagehide keepalive/sendBeacon checkpoints for chats and files plus local emergency cache.
- Independent read-only agent tools now execute in parallel; mutating tools remain ordered.
- Added repeated-tool-call loop guard to prevent runaway cycles.
- Disabled response compression buffering for the SSE chat stream and flushes each event immediately.
- Optimized semantic code search with lexical candidate shortlisting before embeddings.
- Fixed memory deletion parameter bug and added server stability tests.
- Updated Gemini registry with official stable Gemini 3.x models, including Gemini 3.1 Flash-Lite; updated council to Gemini 3.7 Flash.
- Added Gemini function-call IDs to function responses for correct multi-turn tool calling.


## v3 audit completion
- Removed mandatory plan-tool round trips for simple tasks to reduce latency.
- System prompt now asks for tests only where they are meaningful, avoiding needless test loops on trivial UI edits.
- Sidebar model label follows the actual selected provider/model.
- Added official Gemini 3.1 Flash-Lite to the client registry.

- Restored original tool-call ordering after parallel read execution so multi-tool Gemini/Mistral turns remain deterministic.
- Removed stale deleted server chats from the active-session selection logic when the server is reachable.
- Sanitized project ZIP entry paths against absolute/path-traversal names.
- Fixed CORS wildcard/credentials incompatibility for deployments without a configured origin.

## Validation notes
- Server JavaScript: all files pass `node --check` on Node 22 in the build environment.
- Server tests: `node --test` passes 2/2 tests.
- All relative client imports were checked and resolved.
- Client production build could not be executed because package installation timed out in the isolated environment; no claim of a successful Vite build is made.


## v4 full hardening
- Added Gemini streaming watchdog + retry for stalled/429/5xx requests.
- Switched Gemini API authentication from query-string keys to `x-goog-api-key`, avoiding key leakage into URLs/logs.
- Process the final buffered SSE frame for Gemini and Mistral so a provider closing without a trailing newline cannot drop the last token/tool call.
- Added automatic delayed retry for failed durable chat/file saves while keeping local recovery.
- Added a production React error boundary with safe reload/recovery screen.
- Restored mobile browser zoom accessibility by removing `maximum-scale=1` from the viewport.
- Updated the frontend build toolchain to Vite 8.2.x + @vitejs/plugin-react 6.x; Node engine is now >=20.19.0, matching current Vite requirements.
