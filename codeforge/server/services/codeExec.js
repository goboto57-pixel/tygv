/**
 * Real (best-effort sandboxed) command execution.
 *
 * The project "file system" is an in-memory Map (see projectFS.js) that is
 * rebuilt from the client on every request and has no on-disk presence.
 * To actually run a command we have to:
 *   1. materialize the fsMap into a scoped temp directory on disk
 *   2. run the command there, with a timeout / output cap / cwd jail
 *   3. re-read the directory back into the fsMap so file changes
 *      (e.g. `npm init`, a build step writing dist/, a test run) are
 *      reflected back to the client
 *   4. delete the temp directory
 *
 * IMPORTANT — this is explicitly a "best-effort" sandbox, not a real
 * security boundary:
 *   - it runs in the same OS process/user as the API server (no container,
 *     no VM, no seccomp/gVisor)
 *   - isolation comes only from: a command whitelist, a scoped cwd,
 *     a wall-clock timeout, and an output size cap
 *   - it should NOT be exposed to untrusted/multi-tenant users without
 *     adding real container-level isolation (Docker/Firecracker/E2B/etc).
 */

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

// Only these binaries may be invoked. The command is parsed and the first
// token (the binary) is checked against this list — shell metacharacters
// are not interpreted (we never pass `shell: true`), so `&&`, `;`, `|`,
// backticks, `$()`, etc. in a single argv token are inert, not chained
// commands.
const ALLOWED_BINARIES = new Set([
  "npm",
  "npx",
  "node",
  "yarn",
  "pnpm",
  "python3",
  "python",
  "pip",
  "pip3",
  "git",
  "ls",
  "cat",
  "echo",
  "mkdir",
  "pytest",
  "jest",
  "vitest",
  "eslint",
  "tsc"
]);

const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB combined stdout+stderr
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Very small argv tokenizer: splits on whitespace, respects single/double
 * quotes. Good enough for npm/git/node style invocations; deliberately does
 * NOT support shell operators, since we want the command to fail closed
 * (become "not parseable" / wrong-binary) rather than be interpreted as
 * shell.
 */
function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && i + 1 < command.length) {
        // Handle escaped characters inside quotes
        const nextCh = command[i + 1];
        if (nextCh === quote || nextCh === "\\") {
          current += nextCh;
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    // Any shell metacharacter outside quotes is rejected up front rather
    // than silently stripped/ignored.
    if ("&;|`$(){}<>".includes(ch)) {
      throw new Error(
        `Command contains disallowed shell metacharacter '${ch}'. Only a single plain command is allowed (no chaining, no piping, no substitution).`
      );
    }
    current += ch;
  }
  if (quote) throw new Error("Unterminated quote in command.");
  if (current) tokens.push(current);
  return tokens;
}

async function materializeFs(fsMap, dir) {
  for (const [relPath, content] of fsMap.entries()) {
    const full = path.join(dir, relPath);
    if (!full.startsWith(dir)) continue; // guard against path traversal (e.g. "../../etc/passwd")
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

async function readBackFs(dir, fsMap) {
  const IGNORE_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", "dist", "build"]);
  const changed = [];

  async function walk(sub) {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(relPath);
      } else if (entry.isFile()) {
        const full = path.join(dir, relPath);
        const st = await stat(full);
        if (st.size > 1024 * 1024) continue; // skip anything >1MB (binaries, lockfile bloat)
        try {
          const content = await readFile(full, "utf8");
          if (fsMap.get(relPath) !== content) {
            fsMap.set(relPath, content);
            changed.push(relPath);
          }
        } catch {
          // not valid utf8 (binary output) — skip, don't crash the run
        }
      }
    }
  }

  await walk("");
  return changed;
}

/**
 * Execute a whitelisted command against the project's in-memory fsMap.
 *
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, changedFiles: string[]}>}
 */
export async function runCommand({ command, fsMap, timeoutMs = DEFAULT_TIMEOUT_MS, cwdSubdir = "" }) {
  if (!command || typeof command !== "string" || !command.trim()) {
    throw new Error("No command provided.");
  }

  const tokens = tokenize(command.trim());
  const [bin, ...args] = tokens;
  if (!ALLOWED_BINARIES.has(bin)) {
    throw new Error(
      `Command '${bin}' is not on the allowed list (${Array.from(ALLOWED_BINARIES).join(", ")}). Refusing to execute.`
    );
  }

  const clampedTimeout = Math.min(Math.max(1000, timeoutMs), MAX_TIMEOUT_MS);
  const workDir = await mkdtemp(path.join(tmpdir(), "codeforge-exec-"));

  try {
    await materializeFs(fsMap, workDir);

    const cwd = cwdSubdir ? path.join(workDir, cwdSubdir) : workDir;
    if (!cwd.startsWith(workDir)) {
      throw new Error("Invalid working subdirectory.");
    }
    await mkdir(cwd, { recursive: true });

    const result = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const child = spawn(bin, args, {
        cwd,
        shell: false, // critical: never let the OS shell interpret the string
        env: {
          ...process.env,
          // Strip anything that could leak secrets from the host API process
          // into a user-triggered command run.
          MISTRAL_API_KEY: undefined,
          GEMINI_API_KEY: undefined,
          CLOUDINARY_API_SECRET: undefined,
          CI: "true",
          npm_config_yes: "true" // avoid npx interactive install prompts hanging the process
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, clampedTimeout);

      const cap = (buf, chunk) => {
        if (buf.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          return buf;
        }
        return buf + chunk;
      };

      child.stdout.on("data", (d) => {
        stdout = cap(stdout, d.toString());
      });
      child.stderr.on("data", (d) => {
        stderr = cap(stderr, d.toString());
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut: false, truncated });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut, truncated });
      });
    });

    const changedFiles = await readBackFs(workDir, fsMap);

    let outputNote = "";
    if (result.truncated) outputNote += `\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
    if (result.timedOut) outputNote += `\n[process killed: exceeded ${clampedTimeout}ms timeout]`;

    return {
      ok: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      stdout: result.stdout + outputNote,
      stderr: result.stderr,
      timedOut: result.timedOut,
      changedFiles
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export { ALLOWED_BINARIES };
