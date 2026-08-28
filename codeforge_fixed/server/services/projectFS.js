/**
 * In-memory virtual project file system.
 * Each project's state is held per-request (passed in from client, persisted via Cloudinary between turns).
 */

import { runCommand } from "./codeExec.js";
import { embedTexts } from "./mistralClient.js";
import { runMistralWebSearch } from "./webSearchClient.js";

/**
 * Fetches a public web page and returns its readable text. Intended to let the
 * agent ground its work in real docs/APIs/examples. Hard-blocks internal and
 * private addresses to avoid SSRF, caps response size, and strips HTML down to
 * headings/paragraphs/code/links so the model gets a compact, useful excerpt.
 */
async function webFetch(url, prompt) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { error: "web_fetch requires an absolute http(s) URL." };
  }
  let u;
  try { u = new URL(url); } catch { return { error: "Invalid URL." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "Only http(s) URLs are allowed." };
  }
  const host = u.hostname.toLowerCase();
  const blocked = ["localhost", "0.0.0.0"]
    .concat(host.endsWith(".local") ? [host] : [])
    .concat(host.endsWith(".internal") ? [host] : [])
    .concat(host.endsWith(".svc") ? [host] : [])
    .concat(host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.") ? [host] : []);
  if (blocked.length) return { error: "Fetching internal/private addresses is not allowed." };
  if (typeof fetch !== "function") return { error: "web_fetch is not available in this environment." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(u.toString(), {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "CodeForge-Agent/1.0 (+https://codeforge.app)", "Accept": "text/html,application/xhtml+xml,text/markdown,text/plain,*/*" }
    });
    if (!res.ok) return { error: `Fetch failed: HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    let text = Buffer.from(buf).toString("utf8");
    if (text.length > 120 * 1024) text = text.slice(0, 120 * 1024) + "\n…[truncated]";
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("html") || /<html[\s>]/i.test(text)) {
      text = extractReadable(text, prompt);
    }
    return { result: text };
  } catch (e) {
    return { error: `web_fetch error: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function extractReadable(html, prompt) {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const codeBlocks = [];
  t = t.replace(/<(pre|code)[\s\S]*?>([\s\S]*?)<\/(pre|code)>/gi, (_m, _o, body) => {
    codeBlocks.push(body.replace(/<[^>]+>/g, ""));
    return " [CODEBLOCK] ";
  });
  const headings = [];
  t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _lvl, body) => {
    headings.push(`\n## ${body.replace(/<[^>]+>/g, "")}`);
    return "";
  });
  const links = [];
  t = t.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const lab = label.replace(/<[^>]+>/g, "").trim();
    if (lab && /^https?:\/\//i.test(href)) links.push(`- ${lab}: ${href}`);
    return lab;
  });
  t = t.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  t = t.replace(/\s+/g, " ").trim();
  let out = `${headings.join("\n")}\n\n${t}\n`;
  if (codeBlocks.length) out += `\nCODE BLOCKS:\n${codeBlocks.map((c, i) => `--- block ${i + 1} ---\n${c}`).join("\n")}\n`;
  if (links.length) out += `\nLINKS:\n${links.join("\n")}\n`;
  if (prompt) out = `Focus: ${prompt}\n\n${out}`;
  if (out.length > 30 * 1024) out = out.slice(0, 30 * 1024) + "\n…[truncated]";
  return out;
}


// Per-request caches keyed by fsMap instance — naturally expires with request
const embeddingIndexCache = new WeakMap();
const readCache = new WeakMap(); // fsMap -> Map(path -> content) for read_file
function getReadCache(fsMap) {
  if (!readCache.has(fsMap)) readCache.set(fsMap, new Map());
  return readCache.get(fsMap);
}
function invalidateReadCache(fsMap) {
  readCache.delete(fsMap);
}

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
  for (const f of files) {
    if (!f.path || typeof f.path !== "string") continue;
    map.set(f.path, f.content ?? "");
  }
  return map;
}

export function invalidateEmbeddingCache(fsMap) {
  embeddingIndexCache.delete(fsMap);
}

export function fsToArray(fsMap) {
  return Array.from(fsMap.entries()).map(([path, content]) => ({ path, content }));
}

function globToRegExp(glob) {
  // supports *, **, ?, [], {a,b}
  // Convert {a,b} to (a|b) first
  let g = glob.replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").map((s) => s.trim()).join("|")})`);
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\([^)]+\\\)/g, (m) => m.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\|/g, "|"))
    .replace(/\*\*/g, "§DOUBLESTAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/§DOUBLESTAR§/g, ".*");
  // handle [...] already escaped? unescape brackets
  const withBrackets = escaped.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  return new RegExp(`^${withBrackets}$`, "i");
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
  // Strip strings and comments to avoid false positives like const s = "(){" 
  const stripped = content
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g, "");
  const issues = [];
  const pairs = [
    ["(", ")"],
    ["{", "}"],
    ["[", "]"]
  ];
  for (const [open, close] of pairs) {
    const openCount = (stripped.match(new RegExp(`\\${open}`, "g")) || []).length;
    const closeCount = (stripped.match(new RegExp(`\\${close}`, "g")) || []).length;
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
    // pytest can be "1 failed, 3 passed" or "3 passed, 1 failed" or "3 passed"
    let pytestMatch = combined.match(/(\d+)\s*failed,\s*(\d+)\s*passed/i);
    if (pytestMatch) {
      failed = Number(pytestMatch[1]);
      passed = Number(pytestMatch[2]);
      total = passed + failed;
    } else {
      pytestMatch = combined.match(/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?/i);
      if (pytestMatch) {
        passed = Number(pytestMatch[1]);
        failed = pytestMatch[2] ? Number(pytestMatch[2]) : 0;
        total = passed + failed;
      }
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
      const cache = getReadCache(fsMap);
      if (cache.has(args.path)) return { result: cache.get(args.path), cached: true };
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      const max = 6000;
      const out = content.length > max ? content.slice(0, max) + `\n…[обрезано ${content.length - max} символов — запроси конкретный диапазон]` : content;
      cache.set(args.path, out);
      return { result: out };
    }

    case "read_files": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const results = {};
      const missing = [];
      for (const p of paths) {
        if (fsMap.has(p)) {
          let c = fsMap.get(p);
          if (c.length > 6000) c = c.slice(0, 6000) + `\n…[обрезано]`;
          results[p] = c;
        } else missing.push(p);
      }
      return { result: { files: results, missing } };
    }

    case "write_file": {
      if (!args.path || typeof args.path !== "string" || !args.path.trim()) return { error: "path is required and must be non-empty string" };
      if (typeof args.content !== "string") return { error: "content must be a string" };
      const p = args.path.trim();
      if (p.includes("..") || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return { error: "invalid path" };
      if (p.length > 300) return { error: "path too long" };
      if (args.content.length > 1024 * 1024) return { error: "content too large (max 1MB)" };
      const existed = fsMap.has(p);
      fsMap.set(p, args.content);
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
      return { result: `${existed ? "Updated" : "Created"} file: ${p}`, fileChanged: p };
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
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
      return { result: `Edited file: ${args.path}`, fileChanged: args.path };
    }

    case "delete_file": {
      if (!fsMap.has(args.path)) {
        return { error: `File not found: ${args.path}` };
      }
      fsMap.delete(args.path);
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
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
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
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
      if (!args.query || typeof args.query !== "string" || !args.query.trim()) return { error: "query is required" };
      if (args.query.length > 500) return { error: "query too long" };
      const q = args.query.toLowerCase();
      const matches = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(q)) {
            matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
        if (matches.length >= 80) return { result: matches.slice(0, 50) };
      }
      return { result: matches.slice(0, 50) };
    }

    case "grep": {
      if (!args.pattern || typeof args.pattern !== "string") return { error: "pattern is required" };
      if (args.pattern.length > 500) return { error: "pattern too long" };
      // ReDoS protection: limit pattern complexity
      if (/(.)\1{5,}\+/.test(args.pattern) || args.pattern.length > 200) {
        // still allow but with timeout
      }
      let re;
      try {
        re = new RegExp(args.pattern, args.flags || "i");
      } catch (e) {
        return { error: `Invalid regular expression: ${e.message}` };
      }
      const matches = [];
      const start = Date.now();
      for (const [path, content] of fsMap.entries()) {
        if (Date.now() - start > 2000) return { result: matches.slice(0, 80), truncated: true };
        const lines = content.split("\n");
        for (let idx = 0; idx < lines.length; idx++) {
          if (Date.now() - start > 2000) break;
          const line = lines[idx];
          // avoid catastrophic backtracking on very long lines
          const testLine = line.length > 2000 ? line.slice(0, 2000) : line;
          let ok = false;
          try { ok = re.test(testLine); } catch { ok = false; }
          // reset lastIndex for global regex
          if (re.global) re.lastIndex = 0;
          if (ok) matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          if (matches.length >= 80) return { result: matches.slice(0, 80) };
        }
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
        if (chunks.length === 0) return { result: "No indexable source files found in the project." };
        const limit = args?.limit && args.limit > 0 ? Math.min(args.limit, 20) : 8;
        // Shortlist by cheap lexical overlap first; embed only the candidates.
        const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
        const lexical = chunks.map((chunk, index) => {
          const hay = `${chunk.path}\n${chunk.text}`.toLowerCase();
          const hits = terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0);
          return { chunk, index, lexical: hits / Math.max(1, terms.length) };
        }).sort((a, b) => b.lexical - a.lexical);
        const candidateCount = Math.min(chunks.length, 96);
        const candidates = lexical.slice(0, candidateCount);
        const [queryEmbedding] = await embedTexts([query]);
        const scored = candidates
          .map(({ chunk, index, lexical: lexicalScore }) => ({ chunk, score: cosineSimilarity(queryEmbedding, embeddings[index]) * 0.85 + lexicalScore * 0.15 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

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

    case "web_fetch": {
      return await webFetch(args.url, args.prompt);
    }

    // Combines "Code" mode with real web search: this is a regular function
    // tool (unlike the console's built-in web_search connector, which only
    // works through /v1/conversations — see webSearchClient.js), so the
    // normal file-editing agent loop (Mistral Medium/Large/Small, etc) can
    // call it mid-task, right alongside read_file/write_file, whenever it
    // needs current info (a library's latest API, current prices, etc).
    case "web_search": {
      if (!args.query || typeof args.query !== "string") {
        return { error: "web_search requires a 'query' string." };
      }
      try {
        const { text, citations } = await runMistralWebSearch({
          query: args.query,
          premium: !!args.premium
        });
        return { result: { answer: text, sources: citations } };
      } catch (e) {
        return { error: `web_search error: ${e.message}` };
      }
    }

    case "check_preview": {
      return { result: checkPreview(fsMap, args && args.entry) };
    }

    case "duplicate_file": {
      const src = (args.source || args.path || "").replace(/^\/+/, "");
      const dst = (args.destination || args.new_path || "").replace(/^\/+/, "");
      if (!src || !dst) return { error: "source and destination required" };
      if (!fsMap.has(src)) return { error: `Source not found: ${src}` };
      if (src === dst) return { error: "source and destination are the same" };
      fsMap.set(dst, fsMap.get(src));
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
      return { result: `Duplicated ${src} -> ${dst}`, fileChanged: dst };
    }

    case "create_folder": {
      const p = (args.path || "").replace(/^\/+/, "").replace(/\/+$/, "");
      if (!p) return { error: "path required" };
      const keep = `${p}/.keep`;
      if (!fsMap.has(keep)) { fsMap.set(keep, ""); embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap); }
      return { result: `Folder created: ${p}`, fileChanged: keep };
    }

    case "get_project_stats": {
      const files = Array.from(fsMap.entries());
      let totalLines = 0;
      let totalBytes = 0;
      const byExt = {};
      let largest = null;
      for (const [path, content] of files) {
        const bytes = Buffer.byteLength(content || "", "utf8");
        totalBytes += bytes;
        const lines = (content || "").split("\n").length;
        totalLines += lines;
        const ext = (path.split(".").pop() || "").toLowerCase().slice(0, 12);
        byExt[ext] = (byExt[ext] || 0) + 1;
        if (!largest || bytes > largest.bytes) largest = { path, bytes, lines };
      }
      return {
        result: {
          totalFiles: files.length,
          totalLines,
          totalBytes,
          byExt,
          largest,
          avgLinesPerFile: files.length ? Math.round(totalLines / files.length) : 0
        }
      };
    }

    case "todo_scan": {
      const markers = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = (content || "").split("\n");
        lines.forEach((line, idx) => {
          if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
            markers.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
        if (markers.length >= 200) {
          markers.push({ truncated: true, note: "More markers exist, showing first 200" });
          break;
        }
      }
      return { result: markers.length ? markers : "No TODO/FIXME/HACK markers found." };
    }

    case "format_code": {
      const p = (args.path || "").replace(/^\/+/, "");
      if (!p) return { error: "path required" };
      const content = fsMap.get(p);
      if (content === undefined) return { error: `File not found: ${p}` };
      let out = content.split("\n").map((l) => l.replace(/\s+$/g, "")).join("\n");
      out = out.replace(/\n{3,}/g, "\n\n");
      if (out.length && !out.endsWith("\n")) out += "\n";
      if (out !== content) {
        fsMap.set(p, out);
        embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
        return { result: `Formatted ${p} (${content.length} -> ${out.length} bytes)`, fileChanged: p };
      }
      return { result: `Already formatted: ${p}` };
    }

    case "apply_patch": {
      const p = (args.path || "").replace(/^\/+/, "");
      if (!p) return { error: "path required" };
      const content = fsMap.get(p);
      if (content === undefined) return { error: `File not found: ${p}` };
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length) return { error: "edits array required" };
      let cur = content;
      for (let i = 0; i < edits.length; i++) {
        const { old_text, new_text } = edits[i] || {};
        if (typeof old_text !== "string" || !old_text) return { error: `edits[${i}].old_text required` };
        if (cur.indexOf(old_text) === -1) return { error: `edits[${i}] old_text not found` };
        // ensure unique for safety
        if (cur.indexOf(old_text) !== cur.lastIndexOf(old_text)) return { error: `edits[${i}] old_text not unique` };
        cur = cur.replace(old_text, new_text ?? "");
      }
      if (cur !== content) {
        fsMap.set(p, cur);
        embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
        return { result: `Patched ${p} with ${edits.length} edit(s)`, fileChanged: p };
      }
      return { result: `No changes for ${p}` };
    }

    case "analyze_bundle": {
      const files = Array.from(fsMap.entries());
      const byExt = {};
      let total = 0;
      for (const [path, c] of files) {
        const ext = (path.split(".").pop() || "noext").toLowerCase();
        const sz = Buffer.byteLength(c, "utf8");
        byExt[ext] = (byExt[ext] || 0) + sz;
        total += sz;
      }
      const sorted = Object.entries(byExt).sort((a, b) => b[1] - a[1]).map(([ext, sz]) => ({ ext, bytes: sz, pct: total ? Math.round(sz / total * 1000) / 10 : 0 }));
      return { result: { totalBytes: total, byExt: sorted } };
    }

    case "extract_colors": {
      const colors = new Set();
      const re = /#([0-9a-f]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi;
      for (const [, c] of fsMap.entries()) {
        let m; while ((m = re.exec(c)) !== null) colors.add(m[0]);
        re.lastIndex = 0;
      }
      return { result: Array.from(colors).slice(0, 100) };
    }

    case "generate_tests": {
      const p = (args.path || "").replace(/^\/+/, "");
      if (!p) return { error: "path required" };
      if (!fsMap.has(p)) return { error: `File not found: ${p}` };
      const base = p.replace(/\.[^.]+$/, "");
      const testPath = `${base}.test.js`;
      if (fsMap.has(testPath)) return { result: `Test already exists: ${testPath}` };
      const content = `import { describe, it, expect } from "vitest";\nimport mod from "./${p.split("/").pop()}";\n\ndescribe("${p}",()=>{it("smoke",()=>{expect(mod).toBeDefined()})})\n`;
      fsMap.set(testPath, content);
      embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap);
      return { result: `Generated ${testPath}`, fileChanged: testPath };
    }

    case "refactor": {
      const oldName = args.old_name || args.old_text;
      const newName = args.new_name || args.new_text;
      if (!oldName || !newName) return { error: "old_name and new_name required" };
      let count = 0;
      for (const [path, c] of fsMap.entries()) {
        if (c.includes(oldName)) {
          const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`\\b${escaped}\\b`, "g");
          const next = c.replace(re, newName);
          if (next !== c) { fsMap.set(path, next); count++; }
        }
      }
      if (count) { embeddingIndexCache.delete(fsMap); invalidateReadCache(fsMap); }
      return { result: `Refactored ${oldName} -> ${newName} in ${count} file(s)` };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Statically validate the project as a runnable website and return a report.
 */
export function checkPreview(fsMap, entry) {
  const issues = [];
  const paths = Array.from(fsMap.keys());

  let htmlPath = entry && fsMap.has(entry.replace(/^\/+/, "")) ? entry.replace(/^\/+/, "") : null;
  if (!htmlPath) {
    const idx = paths.find((p) => p === "index.html");
    if (idx) htmlPath = idx;
  }
  if (!htmlPath) {
    const any = paths.find((p) => p.endsWith(".html"));
    if (any) htmlPath = any;
  }

  if (!htmlPath) {
    return { ok: false, entry: null, issues: ["No HTML entry point found (expected index.html or any .html file)."] };
  }

  const html = String(fsMap.get(htmlPath) || "");
  const lower = html.toLowerCase();

  if (!/<html[\s>]/.test(lower)) issues.push(`<html> tag missing in ${htmlPath}`);
  if (!/<head[\s>]/.test(lower)) issues.push(`<head> tag missing in ${htmlPath}`);
  if (!/<body[\s>]/.test(lower)) issues.push(`<body> tag missing in ${htmlPath}`);
  // a11y checks
  if (/<img[^>]*>/i.test(html) && !/<img[^>]*alt=/i.test(html)) issues.push(`a11y: <img> without alt in ${htmlPath}`);
  if (!/<html[^>]*lang=/i.test(html)) issues.push(`a11y: <html> missing lang attribute`);
  // seo checks
  if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) issues.push(`seo: missing <title>`);
  if (!/<meta[^>]*name=["']description["'][^>]*>/i.test(html)) issues.push(`seo: missing meta description`);

  const collectRefs = (re) => {
    let m;
    const out = [];
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
  };
  const linkRefs = collectRefs(/<link[^>]+href=["']([^"']+)["']/gi);
  const scriptRefs = collectRefs(/<script[^>]+src=["']([^"']+)["']/gi);

  const checkRef = (ref) => {
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("#") || ref.startsWith("mailto:")) return;
    const norm = ref.replace(/^\/+/, "").split("?")[0].split("#")[0];
    if (!norm) return;
    const candidate = htmlPath.includes("/") ? htmlPath.split("/").slice(0, -1).concat(norm).join("/") : norm;
    if (!fsMap.has(candidate) && !fsMap.has(norm)) {
      issues.push(`Missing referenced asset: ${ref} (from ${htmlPath})`);
    }
  };
  linkRefs.forEach(checkRef);
  scriptRefs.forEach(checkRef);

  return { ok: issues.length === 0, entry: htmlPath, referenced: linkRefs.concat(scriptRefs).length, issues };
}
