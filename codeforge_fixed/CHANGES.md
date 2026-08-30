
## v7 — chat persistence, Netlify→Vercel, tool-exec speed (server + minimal client text)
- **Root cause of "чаты пропадают" found and fixed.** `cloudinaryService.js`'s `loadJson()` fetched raw JSON via a *public, unsigned* URL. Since ~2023 Cloudinary blocks unsigned public delivery of `raw` resources by default on new accounts — so that fetch 401'd, was silently swallowed (`catch { return null }`), and every caller reads `null` as "doesn't exist". Saving was never broken (it goes through the authenticated upload API); only reading a chat back was — exactly matching "open an old chat, it's empty" / "looks like nothing saved". Fixed with `sign_url: true` (Cloudinary's own documented fix for this restriction), and non-404 failures now log a warning instead of silently looking identical to "genuinely doesn't exist".
- **Netlify → Vercel.** `deployService.js` rewritten against Vercel's inline-files deploy API (`POST /v13/deployments`, no zip needed). Same chat→one-project mapping as before (redeploy updates the same URL). Specifically handles the failure mode most likely behind the original "не авторизован": a **team-scoped Vercel token needs `teamId` on every request** or Vercel 403s even with a valid token — added `VERCEL_TEAM_ID` env var for exactly that case, with the error hint pointing straight at it. Needs `VERCEL_TOKEN` (+ `VERCEL_TEAM_ID` if applicable) in env — see `.env.example`. Not able to test against a real Vercel account in this environment, so verify one real deploy after setting the token.
- **Tool execution (`run_command`/`run_tests`) sped up for real.** `codeExec.js` materialized/read back the project's files one at a time in a sequential `for`-loop (`await` per file) — parallelized both directions with `Promise.all`. Real wall-clock savings on any project with more than a couple files, on every single command/test run.
- **What's NOT fixed here, on purpose (needs more scope/your input):** the per-tool-call latency from needing a fresh model round-trip whenever the next step genuinely depends on the previous tool's result is architectural to any tool-calling agent (Claude Code, Cursor, etc. included) — already mitigated where safe via `write_files`/`lint_files`/`read_files` batching (v5), not eliminable beyond that. "No real memory/context window": project files are deliberately NOT stuffed into every prompt (kept out via on-demand `read_file`/tools) to control cost — this trades a "the agent doesn't already know the project" feeling for real token savings; happy to revisit if that trade-off is wrong for how this is actually used. UI complexity/bugs: too broad a surface to responsibly fix in one pass without specifics — please point to concrete broken flows/screens and they'll get the same treatment as everything above.
- **Loop cap was a hard wall guessed by regex, cutting off turns mid-task.** `taskComplexity.js`'s classifier decides `MAX_LOOPS` from keyword matching alone; when it under-estimated a task, the agent hit `stopWithProgress()` while still visibly making progress (files being written every iteration) — reads to the user as the agent giving up/being dumb. `MAX_LOOPS` is now mutable with a bounded "grace" extension (`agentLoop.js`: `checkTimeAndGrace`): if the turn hits the cap but changed a file in the last iteration (real progress, distinct from the existing repeated-tool-call guard which still catches genuine stuck loops), it gets extended once by ~30%, up to a hard ceiling of 1.5x the original budget. Wired into both loop implementations (the Conversations-API path used for normal single-mode Mistral turns, and the legacy chat.completions loop used for council/collab/vision/Gemini/Cloudflare).
- **No wall-clock ceiling on a turn.** Every individual model/tool call had its own retry cap, but nothing capped the turn as a whole — a turn that kept looping (even successfully) could run for minutes with no upper bound, which is what "slow" actually felt like. Added `TURN_TIME_BUDGET_MS`, tiered by task size (60s trivial → 420s big), checked every loop iteration in the same `checkTimeAndGrace` helper.
- **Single-shot truncation paid for the failed attempt AND the full fallback loop.** `runSingleShotPath()` previously fell straight through to the entire multi-turn tool loop on ANY parse failure, including a plain "ran out of tokens" truncation — a predictable, recoverable failure, not a real parse error. It now retries once in-place with a ~1.6x bigger token cap before giving up on single-shot, which is far cheaper than re-doing the whole task via the tool loop.
- **Project memory was re-sent unbounded on every turn.** `renderMemoryForPrompt()` (`memoryService.js`) used to inline ALL stored entries (up to 60 × 400 chars, ~6000 tokens worst case) into the system prompt on every single turn of a long-lived project, regardless of relevance to the current request. Now capped to the most recent 20 entries and a ~2500-char rendered block, with an explicit "N older notes omitted" note so this isn't silently lossy.
- **No cost/speed adapted to task size on model choice.** The model was whatever the UI had selected, with no relationship to how big the task actually was — a one-line tweak paid full Medium/Large latency, while backend/auth tasks got the same treatment as a landing page. Added `autoRouteModel()` (`taskComplexity.js`): when the caller passes `model: "auto"` (or omits it), the model is picked from the same tier classifier already used for loop/token budgets (Ministral 8B/14B for trivial/fix, Medium for simple/general, Large for big). Purely additive — never overrides an explicit model choice.
- Added regression tests for the two new pure functions (`autoRouteModel`, the memory-render cap) in `stability.test.js`; `node --test` now passes 6/6 (was 4/4).

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
