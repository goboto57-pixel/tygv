/**
 * Git integration.
 *
 * Constraint we're working within: project state is NOT stored as files on
 * disk anywhere persistent — it's JSON blobs in Cloudinary (see
 * cloudinaryService.js), one blob per Snapshot, each holding a full
 * { files: [{path, content}] } array plus a label/timestamp.
 *
 * So there is nowhere to keep a real long-lived `.git` directory between
 * requests. Instead of faking git output with string manipulation, this
 * module reconstructs a REAL repository on demand:
 *
 *   1. take the ordered list of snapshots for a chat (oldest -> newest)
 *   2. for each one, materialize its files into a scratch dir and run
 *      `git add -A && git commit` for real
 *   3. the result is an actual git repo with an actual commit history,
 *      against which `git log`, `git diff`, `git show` etc. are run for
 *      real and their real output is returned
 *   4. the scratch dir (including .git) is deleted after the request
 *
 * This means: every git operation here reflects true git semantics (diff
 * algorithm, rename detection, etc.) — it's just that the repo is rebuilt
 * each time rather than persisted. For a chat with many snapshots this is
 * O(snapshots) commits to replay, which is fine for interactive use but
 * not something to run on every keystroke.
 */

import { spawn } from "child_process";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const GIT_AUTHOR = { name: "CodeForge Agent", email: "agent@codeforge.local" };

function run(bin, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`${bin} ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function writeFilesToDir(dir, files) {
  // Clear tracked files first isn't needed since we git-add -A each time
  // and deletions between snapshots are handled by removing files that
  // existed before and are absent now.
  for (const f of files) {
    const full = path.join(dir, f.path);
    if (!full.startsWith(dir)) continue;
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, f.content ?? "", "utf8");
  }
}

async function removeStaleFiles(dir, prevFiles, nextFiles) {
  const nextPaths = new Set(nextFiles.map((f) => f.path));
  const toRemove = prevFiles.filter((f) => !nextPaths.has(f.path));
  for (const f of toRemove) {
    await run("git", ["rm", "-f", "--ignore-unmatch", f.path], dir).catch(() => {});
  }
}

/**
 * Build a real git repo from an ordered list of snapshots and run a
 * callback against it, cleaning up afterward.
 *
 * @param {Array<{id, label, createdAt, files}>} snapshots oldest -> newest
 * @param {(repoDir: string, commitShas: string[]) => Promise<any>} fn
 */
async function withReplayedRepo(snapshots, fn) {
  if (!snapshots.length) throw new Error("No snapshots to build a git history from.");

  const dir = await mkdtemp(path.join(tmpdir(), "codeforge-git-"));
  try {
    await run("git", ["init", "-q"], dir);
    await run("git", ["config", "user.name", GIT_AUTHOR.name], dir);
    await run("git", ["config", "user.email", GIT_AUTHOR.email], dir);
    await run("git", ["config", "commit.gpgsign", "false"], dir);

    const shas = [];
    let prevFiles = [];
    for (const snap of snapshots) {
      const files = snap.files || [];
      await removeStaleFiles(dir, prevFiles, files);
      await writeFilesToDir(dir, files);
      await run("git", ["add", "-A"], dir);

      const dateIso = snap.createdAt || new Date().toISOString();
      const message = snap.label || `Snapshot ${snap.id}`;

      try {
        await run("git", ["commit", "-q", "-m", message, "--allow-empty", "--date", dateIso], dir, {
          GIT_AUTHOR_DATE: dateIso,
          GIT_COMMITTER_DATE: dateIso
        });
      } catch (err) {
        // "nothing to commit" happens legitimately if two snapshots are identical
        if (!/nothing to commit/.test(err.stderr || "")) throw err;
      }

      const { stdout } = await run("git", ["rev-parse", "HEAD"], dir);
      shas.push(stdout.trim());
      prevFiles = files;
    }

    return await fn(dir, shas);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Real `git log` output over the replayed snapshot history. */
export async function gitLog(snapshots) {
  return withReplayedRepo(snapshots, async (dir) => {
    const { stdout } = await run(
      "git",
      ["log", "--pretty=format:%H|%ad|%s", "--date=iso-strict"],
      dir
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...msgParts] = line.split("|");
        return { hash, date, message: msgParts.join("|") };
      });
  });
}

/**
 * Real `git diff` between two snapshot indices (or HEAD~1..HEAD if
 * omitted), using actual git diff algorithm — not a hand-rolled line
 * differ.
 */
export async function gitDiff(snapshots, { from, to } = {}) {
  return withReplayedRepo(snapshots, async (dir, shas) => {
    const toSha = to !== undefined ? shas[to] : shas[shas.length - 1];
    const fromSha = from !== undefined ? shas[from] : shas[Math.max(0, shas.length - 2)];
    if (!toSha || !fromSha) throw new Error("Snapshot index out of range.");
    const { stdout } = await run("git", ["diff", fromSha, toSha, "--", "."], dir);
    const { stdout: statOut } = await run("git", ["diff", "--stat", fromSha, toSha], dir);
    return { diff: stdout, stat: statOut, fromSha, toSha };
  });
}

/** Real `git show <sha>` for a specific commit (patch form). */
export async function gitShow(snapshots, index) {
  return withReplayedRepo(snapshots, async (dir, shas) => {
    const sha = shas[index];
    if (!sha) throw new Error("Snapshot index out of range.");
    const { stdout } = await run("git", ["show", sha], dir);
    return { sha, patch: stdout };
  });
}
