/**
 * In-memory virtual project file system.
 * Each project's state is held per-request (passed in from client, persisted via Cloudinary between turns).
 */

import { runCommand } from "./codeExec.js";
import { embedTexts } from "./mistralClient.js";

// Per-request embeddings cache, keyed by fsMap instance. A fresh fsMap is
// created for every /chat/stream call (see agentLoop.js), so this naturally
// expires with the request — no cross-user/session leakage, no manual
// invalidation needed when files change mid-turn (the index is just
// rebuilt lazily the next time semantic_search runs against the same fsMap).
const embeddingIndexCache = new WeakMap();

const CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|java|go|rs|rb|php|c|cpp|h|hpp|cs|html|css|scss|json|md|vue|svelte)$/i;
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;
const MAX_CHUNKS = 400; // caps embedding cost/latency for very large projects

function chunkFile(path, content) {
  const lines = content.split("\n");
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join("\n");
    if (text.trim()) chunks.push({ path, startLine: start + 1, endLine: end, text });
    if (end === lines.length) break;
  }
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function getOrBuildIndex(fsMap) {
  const cached = embeddingIndexCache.get(fsMap);
  if (cached) return cached;

  const chunks = [];
  for (const [path, content] of fsMap.entries()) {
    if (!CODE_EXTENSIONS.test(path)) continue;
    if (content.length > 200 * 1024) continue; // skip huge generated/lock files
    chunks.push(...chunkFile(path, content));
    if (chunks.length >= MAX_CHUNKS) break;
  }

  if (chunks.length === 0) {
    const empty = { chunks: [], embeddings: [] };
    embeddingIndexCache.set(fsMap, empty);
    return empty;
  }

  const embeddings = await embedTexts(chunks.map((c) => c.text));
  const index = { chunks, embeddings };
  embeddingIndexCache.set(fsMap, index);
  return index;
}

export function createFSFromFiles(files = []) {
  // files: [{ path, content }]
  const map = new Map();
  for (const f of files) map.set(f.path, f.content);
  return map;
}

export function fsToArray(fsMap) {
  return Array.from(fsMap.entries()).map(([path, content]) => ({ path, content }));
}

function globToRegExp(glob) {
  // very small glob subset: * (any chars except /), ** (any chars incl /)
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLESTAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLESTAR§/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function buildDirectoryTree(fsMap) {
  const root = {};
  for (const path of fsMap.keys()) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (isFile) {
        node.__files = node.__files || [];
        node.__files.push(part);
      } else {
        node[part] = node[part] || {};
        node = node[part];
      }
    });
  }

  function render(node, prefix = "") {
    let lines = [];
    const dirs = Object.keys(node).filter((k) => k !== "__files").sort();
    const files = (node.__files || []).sort();
    dirs.forEach((d) => {
      lines.push(`${prefix}${d}/`);
      lines = lines.concat(render(node[d], prefix + "  "));
    });
    files.forEach((f) => {
      lines.push(`${prefix}${f}`);
    });
    return lines;
  }

  return render(root).join("\n") || "(empty project)";
}

function lintText(path, content) {
  const issues = [];
  const pairs = [
    ["(", ")"],
    ["{", "}"],
    ["[", "]"]
  ];
  for (const [open, close] of pairs) {
    const openCount = (content.match(new RegExp(`\\${open}`, "g")) || []).length;
    const closeCount = (content.match(new RegExp(`\\${close}`, "g")) || []).length;
    if (openCount !== closeCount) {
      issues.push(`Unbalanced '${open}${close}': ${openCount} open vs ${closeCount} close`);
    }
  }
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    if (/\bTODO\b|\bFIXME\b/.test(line)) {
      issues.push(`Line ${idx + 1}: marker found — "${line.trim().slice(0, 100)}"`);
    }
    if (line.length > 200) {
      issues.push(`Line ${idx + 1}: very long line (${line.length} chars)`);
    }
  });
  return issues;
}

function parseTestOutput(stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  // Best-effort parsing across jest/vitest ("Tests: 3 passed, 1 failed, 4 total")
  // and pytest ("3 passed, 1 failed in 0.42s") summary line formats.
  let passed = null;
  let failed = null;
  let total = null;

  const jestMatch = combined.match(/Tests:\s*(?:(\d+)\s*failed,\s*)?(?:(\d+)\s*passed,\s*)?(\d+)\s*total/i);
  if (jestMatch) {
    failed = jestMatch[1] ? Number(jestMatch[1]) : 0;
    passed = jestMatch[2] ? Number(jestMatch[2]) : 0;
    total = Number(jestMatch[3]);
  } else {
    const pytestMatch = combined.match(/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i);
    if (pytestMatch) {
      passed = Number(pytestMatch[1]);
      failed = pytestMatch[2] ? Number(pytestMatch[2]) : 0;
      total = passed + failed;
    }
  }

  return { passed, failed, total };
}

async function detectAndRunTests({ fsMap, path: scopedPath, timeoutMs }) {
  const files = Array.from(fsMap.keys());
  const hasPackageJson = fsMap.has("package.json");
  const hasPytestFiles = files.some((p) => /(^|\/)test_[^/]+\.py$|_test\.py$/.test(p));
  const hasJsTestFiles = files.some((p) => /\.(test|spec)\.[jt]sx?$/.test(p));

  let command = null;

  if (hasPackageJson) {
    let pkg = {};
    try {
      pkg = JSON.parse(fsMap.get("package.json") || "{}");
    } catch {
      pkg = {};
    }
    if (pkg.scripts && pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) {
      command = "npm test";
    } else if (hasJsTestFiles) {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      command = deps.vitest ? "npx vitest run" : "npx jest";
    }
  } else if (hasPytestFiles) {
    command = "pytest -q";
  }

  if (!command) {
    return {
      ran: false,
      message:
        "No test runner detected (no npm test script, no *.test.js/*.spec.js files, no test_*.py files). Write test files first, or add a \"test\" script to package.json."
    };
  }

  const outcome = await runCommand({ command, fsMap, timeoutMs });
  const { passed, failed, total } = parseTestOutput(outcome.stdout, outcome.stderr);

  return {
    ran: true,
    command,
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    passed,
    failed,
    total,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    changedFiles: outcome.changedFiles
  };
}

export async function executeTool(toolName, args, fsMap) {
  switch (toolName) {
    case "list_files": {
      const list = Array.from(fsMap.entries()).map(([path, content]) => ({
        path,
        size: content.length
      }));
      return { result: list };
    }

    case "list_directory_tree": {
      return { result: buildDirectoryTree(fsMap) };
    }

    case "read_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      return { result: content };
    }

    case "read_files": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const results = {};
      const missing = [];
      for (const p of paths) {
        if (fsMap.has(p)) results[p] = fsMap.get(p);
        else missing.push(p);
      }
      return { result: { files: results, missing } };
    }

    case "write_file": {
      const existed = fsMap.has(args.path);
      fsMap.set(args.path, args.content);
      return { result: `${existed ? "Updated" : "Created"} file: ${args.path}`, fileChanged: args.path };
    }

    case "edit_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      const oldText = args.old_text;
      if (typeof oldText !== "string" || oldText === "") {
        return { error: "old_text must be a non-empty string" };
      }
      let occurrences = 0;
      let index = 0;
      while ((index = content.indexOf(oldText, index)) !== -1) {
        occurrences++;
        index += oldText.length;
      }
      if (occurrences === 0) {
        return { error: `old_text not found in ${args.path}` };
      }
      if (occurrences > 1) {
        return { error: `old_text is not unique in ${args.path} (${occurrences} matches). Provide more context.` };
      }
      const newContent = content.replace(oldText, args.new_text ?? "");
      fsMap.set(args.path, newContent);
      return { result: `Edited file: ${args.path}`, fileChanged: args.path };
    }

    case "delete_file": {
      if (!fsMap.has(args.path)) {
        return { error: `File not found: ${args.path}` };
      }
      fsMap.delete(args.path);
      return { result: `Deleted file: ${args.path}`, fileDeleted: args.path };
    }

    case "rename_file": {
      if (!fsMap.has(args.old_path)) {
        return { error: `File not found: ${args.old_path}` };
      }
      if (fsMap.has(args.new_path)) {
        return { error: `Target path already exists: ${args.new_path}` };
      }
      const content = fsMap.get(args.old_path);
      fsMap.delete(args.old_path);
      fsMap.set(args.new_path, content);
      return {
        result: `Renamed ${args.old_path} -> ${args.new_path}`,
        fileDeleted: args.old_path,
        fileChanged: args.new_path
      };
    }

    case "find_files": {
      const re = globToRegExp(args.pattern || "*");
      const matches = Array.from(fsMap.keys()).filter((p) => re.test(p));
      return { result: matches };
    }

    case "search_code": {
      const matches = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(args.query.toLowerCase())) {
            matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
      return { result: matches.slice(0, 50) };
    }

    case "grep": {
      let re;
      try {
        re = new RegExp(args.pattern, args.flags || "i");
      } catch (e) {
        return { error: `Invalid regular expression: ${e.message}` };
      }
      const matches = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (re.test(line)) {
            matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
      return { result: matches.slice(0, 80) };
    }

    case "make_plan": {
      return { result: { title: args.title, steps: args.steps }, isPlan: true };
    }

    case "run_command": {
      try {
        const outcome = await runCommand({
          command: args.command,
          fsMap,
          timeoutMs: args.timeout_ms
        });
        const header = `$ ${args.command}${outcome.timedOut ? "  [TIMED OUT]" : ""}\n(exit code ${outcome.exitCode ?? "n/a"})`;
        const body = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n--- stderr ---\n");
        const text = [header, body].filter(Boolean).join("\n");
        return {
          result: text || header,
          terminalCommand: args.command,
          filesChanged: outcome.changedFiles, // multiple files may change (e.g. `npm init`, test runs writing coverage/, etc.)
          error: outcome.ok ? undefined : (outcome.timedOut ? "Command timed out." : `Command exited with code ${outcome.exitCode}.`)
        };
      } catch (err) {
        return {
          error: err.message,
          terminalCommand: args.command,
          result: `$ ${args.command}\n[blocked] ${err.message}`
        };
      }
    }

    case "semantic_search": {
      try {
        const query = (args?.query || "").trim();
        if (!query) return { error: "query is required" };
        const { chunks, embeddings } = await getOrBuildIndex(fsMap);
        if (chunks.length === 0) {
          return { result: "No indexable source files found in the project." };
        }
        const [queryEmbedding] = await embedTexts([query]);
        const scored = chunks
          .map((chunk, i) => ({ chunk, score: cosineSimilarity(queryEmbedding, embeddings[i]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, args?.limit && args.limit > 0 ? Math.min(args.limit, 20) : 8);

        const result = scored.map(({ chunk, score }) => ({
          path: chunk.path,
          lines: `${chunk.startLine}-${chunk.endLine}`,
          relevance: Math.round(score * 1000) / 1000,
          snippet: chunk.text.slice(0, 600)
        }));
        return { result };
      } catch (err) {
        return { error: `semantic_search failed: ${err.message}` };
      }
    }

    case "run_tests": {
      try {
        const outcome = await detectAndRunTests({ fsMap, timeoutMs: args?.timeout_ms });
        if (!outcome.ran) {
          return { result: outcome.message };
        }
        const summaryBits = [];
        if (outcome.total != null) summaryBits.push(`${outcome.passed}/${outcome.total} passed`);
        const header = `$ ${outcome.command}${outcome.timedOut ? "  [TIMED OUT]" : ""}\n(exit code ${outcome.exitCode ?? "n/a"}${summaryBits.length ? ", " + summaryBits.join(", ") : ""})`;
        const body = [outcome.stdout, outcome.stderr].filter(Boolean).join("\n--- stderr ---\n");
        const text = [header, body].filter(Boolean).join("\n");
        return {
          result: text || header,
          terminalCommand: outcome.command,
          testRun: {
            command: outcome.command,
            ok: outcome.ok,
            passed: outcome.passed,
            failed: outcome.failed,
            total: outcome.total,
            timedOut: outcome.timedOut
          },
          filesChanged: outcome.changedFiles,
          error: outcome.ok ? undefined : (outcome.timedOut ? "Test run timed out." : `Tests failed (exit code ${outcome.exitCode}).`)
        };
      } catch (err) {
        return { error: err.message, result: `[test run blocked] ${err.message}` };
      }
    }

    case "lint_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      const issues = lintText(args.path, content);
      return { result: issues.length ? issues : ["No obvious issues found."] };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
