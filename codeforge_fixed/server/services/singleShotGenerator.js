/**
 * SINGLE-SHOT GENERATION PATH
 *
 * For a brand-new project (no files yet), the normal agent loop costs at
 * least 2 model round-trips even for one file: the model must emit a
 * write_file tool call, wait for the server to execute it, then generate a
 * second turn to produce a final summary. Every extra tool call is a full
 * network round trip PLUS a full extra generation, not just perceived
 * latency.
 *
 * This path removes tools from the loop entirely for the "create from
 * scratch" case: the model writes ALL project files directly in its text
 * response as marked code blocks, and this module parses them out. That's
 * 1 model call = a finished project, matching how Le Chat and most
 * site-generators actually work.
 *
 * Only safe for creation (empty project => nothing to read first). Edits
 * to an existing project still need the tool loop, since the model has to
 * read a file before it can know what to change.
 */

const FILE_MARKER_RE = /@@FILE:\s*([^\n@]+?)\s*@@\s*\n```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```/g;
const DELETE_MARKER_RE = /@@DELETE:\s*([^\n@]+?)\s*@@/g;

export function buildSingleShotSystemPrompt(baseSystemPrompt, { existingFiles = null } = {}) {
  const creationRules = `SINGLE-SHOT MODE: this is a brand-new, empty project. You will NOT be given any tools this turn — do not attempt to call one. Instead, write the ENTIRE project directly in your response as plain text, using exactly this format for every file:`;

  const editRules = `SINGLE-SHOT MODE: you will NOT be given any tools this turn — do not attempt to call read_file/write_file/edit_file or anything else. The full current content of every project file is already included below, so there is nothing left to read. Respond directly with ONLY the files that need to change, in this exact format:`;

  const fileFormatBlock = `
@@FILE: path/to/file.ext@@
\`\`\`
<full file content>
\`\`\`

- One @@FILE: ...@@ marker + one fenced code block per file, back to back, no other text between them.
- Use relative paths only (e.g. index.html, css/style.css, js/app.js) — no leading slash, no "..".
- Write COMPLETE, working file contents for every file you include — never truncate or use "// rest unchanged" placeholders. If you're touching a 200-line file to fix one line, still output all 200 lines.`;

  const editOnlyRules = `
- Do NOT re-output files you are not changing — omitted files are left exactly as they are. If a file needs to be deleted, use "@@DELETE: path/to/file.ext@@" instead of a file block for it.
- Only include a file if something in it actually needs to change.`;

  const tail = `
- After all file/delete blocks, write a short (2-4 sentence) plain-text summary of what you changed. This summary must come AFTER the last block.
- Do not wrap explanations between file blocks — all prose goes in the summary at the end.`;

  let prompt = `${baseSystemPrompt}\n\n${existingFiles ? editRules : creationRules}${fileFormatBlock}${existingFiles ? editOnlyRules : ""}${tail}`;

  if (existingFiles) {
    const listing = existingFiles.map(([p, c]) => `@@FILE: ${p}@@\n\`\`\`\n${c}\n\`\`\``).join("\n\n");
    prompt += `\n\nCURRENT PROJECT FILES:\n\n${listing}`;
  }

  return prompt;
}

/**
 * Parses a single-shot model response into changed files + deleted paths +
 * trailing summary text. Applies the same path-safety rules as the
 * write_file tool so this path can never write outside the project
 * (traversal, absolute paths, etc).
 */
export function parseSingleShotResponse(text) {
  const files = [];
  const deletions = [];
  const rejected = [];
  let lastIndex = 0;
  let match;
  FILE_MARKER_RE.lastIndex = 0;

  const isSafePath = (p) => p && !p.includes("..") && !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && p.length <= 300;

  while ((match = FILE_MARKER_RE.exec(text)) !== null) {
    const rawPath = match[1].trim();
    const content = match[2];
    lastIndex = FILE_MARKER_RE.lastIndex;

    if (!isSafePath(rawPath)) { rejected.push(rawPath || "(empty path)"); continue; }
    if (content.length > 1024 * 1024) { rejected.push(rawPath); continue; }
    files.push({ path: rawPath, content });
  }

  DELETE_MARKER_RE.lastIndex = 0;
  while ((match = DELETE_MARKER_RE.exec(text)) !== null) {
    const rawPath = match[1].trim();
    lastIndex = Math.max(lastIndex, DELETE_MARKER_RE.lastIndex);
    if (!isSafePath(rawPath)) { rejected.push(rawPath || "(empty path)"); continue; }
    deletions.push(rawPath);
  }

  // Everything after the last parsed block is the summary; if nothing
  // parsed at all, fall back to the full text so the caller can still show
  // something (and, more importantly, decide to fall back to the tool loop).
  const summary = (files.length > 0 || deletions.length > 0 ? text.slice(lastIndex) : text).trim();

  return { files, deletions, rejected, summary };
}

// Cheap upfront gate for whether a whole project can safely be inlined into
// one prompt (context budget + a sane cap on file count so the model isn't
// asked to silently re-scan hundreds of files it wasn't asked about).
//
// Raised from the original 25 files / 60,000 chars: that threshold sent the
// bulk of real edits (anything past a handful of files) into the multi-round
// tool loop, where EVERY file costs a full extra model round-trip (see
// module docstring above) — that loop, not the single-shot path, is the
// actual reason ordinary edits were taking minutes. Mistral Medium/Large
// comfortably handle a ~200K-char prompt, so this was leaving a lot of
// legitimate single-shot-eligible edits on the table for no real reason.
const SINGLE_SHOT_MAX_TOTAL_CHARS = 160_000;
const SINGLE_SHOT_MAX_FILES = 60;

export function isProjectSmallEnoughForSingleShot(fsMap) {
  if (fsMap.size === 0) return true; // new project — nothing to inline
  if (fsMap.size > SINGLE_SHOT_MAX_FILES) return false;
  let total = 0;
  for (const content of fsMap.values()) {
    total += content.length;
    if (total > SINGLE_SHOT_MAX_TOTAL_CHARS) return false;
  }
  return true;
}
