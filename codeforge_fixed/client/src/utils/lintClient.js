/**
 * Client-side mirror of the server's lintText (projectFS.js) — deliberately
 * kept just as lightweight (bracket balance, TODO/FIXME markers, very long
 * lines) so it can run on every keystroke without a round trip. Not meant
 * to replace the agent's own lint_file tool call, which runs the
 * authoritative version server-side after real edits — this is purely for
 * instant feedback while a human is typing in the inline editor.
 */
export function lintTextClient(content) {
  const issues = [];
  if (!content) return issues;

  const pairs = [
    ["(", ")"],
    ["{", "}"],
    ["[", "]"]
  ];
  for (const [open, close] of pairs) {
    const openCount = (content.match(new RegExp(`\\${open}`, "g")) || []).length;
    const closeCount = (content.match(new RegExp(`\\${close}`, "g")) || []).length;
    if (openCount !== closeCount) {
      issues.push({ line: null, text: `Дисбаланс '${open}${close}': ${openCount} откр. / ${closeCount} закр.` });
    }
  }

  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    if (/\bTODO\b|\bFIXME\b/.test(line)) {
      issues.push({ line: idx + 1, text: `метка ${line.match(/\bTODO\b|\bFIXME\b/)[0]}` });
    }
    if (line.length > 200) {
      issues.push({ line: idx + 1, text: `очень длинная строка (${line.length} симв.)` });
    }
  });

  return issues;
}
