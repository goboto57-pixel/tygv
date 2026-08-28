
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
