export const READ_ONLY_TOOLS = new Set([
  "list_files",
  "list_directory_tree",
  "read_file",
  "read_files",
  "find_files",
  "search_code",
  "grep",
  "semantic_search",
  "lint_file",
  "web_fetch",
  "check_preview",
  "get_project_stats",
  "todo_scan"
]);

export function splitToolCalls(calls = []) {
  const prepared = calls.map((call) => ({
    call,
    readOnly: READ_ONLY_TOOLS.has(call?.function?.name)
  }));
  return {
    readOnly: prepared.filter((item) => item.readOnly),
    ordered: prepared.filter((item) => !item.readOnly)
  };
}
