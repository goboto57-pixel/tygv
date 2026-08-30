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
  // lint_files (the batch variant) was missing here even though lint_file
  // (singular) was present — every batch lint call was falling into the
  // "ordered/mutating" bucket and running serialized behind writes instead
  // of in parallel with other reads, silently costing a full extra
  // round-trip on every "lint after write_files" turn (the exact pattern
  // the system prompt tells the agent to use).
  "lint_files",
  "web_fetch",
  // web_search never mutates the project file tree either — it was being
  // treated as an "ordered" (write-like) call for no reason, which forced
  // it to run sequentially even when the model requested it alongside
  // other independent reads in the same turn.
  "web_search",
  "check_preview",
  "get_project_stats",
  "todo_scan",
  "analyze_bundle",
  "extract_colors",
  // New: outline_file (see toolDefinitions.js) — pure read, safe to
  // parallelize with everything else in this set.
  "outline_file"
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
