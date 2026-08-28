/**
 * Computes a lightweight quality snapshot of the project at the end of an
 * agent turn — not a replacement for real static analysis, just enough
 * signal for the "session report" panel to show something concrete besides
 * a wall of chat text: size, test coverage presence, lint issues, how much
 * the agent actually touched.
 */
import { executeTool } from "./projectFS.js";

const CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|java|go|rs|rb|php|c|cpp|h|hpp|cs|vue|svelte)$/i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

export async function computeSessionMetrics({ fsMap, changedPaths, testRuns }) {
  const allFiles = Array.from(fsMap.entries());
  const codeFiles = allFiles.filter(([path]) => CODE_EXTENSIONS.test(path));
  const testFiles = allFiles.filter(([path]) => TEST_FILE_PATTERN.test(path));

  let totalLines = 0;
  let longestFile = null;
  for (const [path, content] of codeFiles) {
    const lines = content.split("\n").length;
    totalLines += lines;
    if (!longestFile || lines > longestFile.lines) longestFile = { path, lines };
  }

  // Lint only the files this turn actually touched — running the whole
  // project's lint_file on every turn would be wasted work on files the
  // agent never looked at, and would make "issues found" drift based on
  // pre-existing code rather than what just changed.
  const lintIssues = [];
  const uniqueChanged = Array.from(new Set(changedPaths || [])).filter((p) => fsMap.has(p));
  for (const path of uniqueChanged) {
    const { result } = await executeTool("lint_file", { path }, fsMap);
    if (Array.isArray(result) && result[0] !== "No obvious issues found.") {
      lintIssues.push({ path, issues: result });
    }
  }

  const testSummary = (testRuns || []).reduce(
    (acc, t) => ({
      ranAny: acc.ranAny || true,
      allPassed: acc.allPassed && !!t.ok,
      lastPassed: t.passed ?? acc.lastPassed,
      lastTotal: t.total ?? acc.lastTotal
    }),
    { ranAny: false, allPassed: true, lastPassed: null, lastTotal: null }
  );

  return {
    filesTotal: allFiles.length,
    codeFilesTotal: codeFiles.length,
    testFilesTotal: testFiles.length,
    hasTestCoverage: testFiles.length > 0,
    totalLines,
    longestFile,
    filesChangedThisTurn: uniqueChanged.length,
    lintIssues,
    testSummary
  };
}
