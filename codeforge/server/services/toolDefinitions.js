/**
 * Tool schema for Mistral function calling — concise descriptions for token economy.
 */
export const toolDefinitions = [
  { type: "function", function: { name: "list_files", description: "List files with path and size.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "list_directory_tree", description: "Directory tree of project.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_file", description: "Read file by path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_files", description: "Read multiple files.", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] } } },
  { type: "function", function: { name: "write_file", description: "Create/overwrite file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Find-replace edit (unique old_text).", parameters: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } } },
  { type: "function", function: { name: "delete_file", description: "Delete file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "rename_file", description: "Rename/move file.", parameters: { type: "object", properties: { old_path: { type: "string" }, new_path: { type: "string" } }, required: ["old_path", "new_path"] } } },
  { type: "function", function: { name: "find_files", description: "Find by glob pattern (*).", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "search_code", description: "Plain text search.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "grep", description: "Regex search.", parameters: { type: "object", properties: { pattern: { type: "string" }, flags: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "make_plan", description: "Create step plan for complex task.", parameters: { type: "object", properties: { title: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] } } }, required: ["title", "steps"] } } },
  { type: "function", function: { name: "run_command", description: "Run shell command (allowlist, sandboxed).", parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] } } },
  { type: "function", function: { name: "semantic_search", description: "Semantic search via embeddings.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } } },
  { type: "function", function: { name: "run_tests", description: "Run tests (npm/jest/vitest/pytest).", parameters: { type: "object", properties: { timeout_ms: { type: "number" } }, required: [] } } },
  { type: "function", function: { name: "lint_file", description: "Lint file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "check_preview", description: "Validate site (HTML/assets).", parameters: { type: "object", properties: { entry: { type: "string" } }, required: [] } } },
  { type: "function", function: { name: "web_fetch", description: "Fetch public URL text.", parameters: { type: "object", properties: { url: { type: "string" }, prompt: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "save_memory", description: "Save durable memory.", parameters: { type: "object", properties: { text: { type: "string" }, category: { type: "string", enum: ["convention", "decision", "constraint", "preference", "note"] } }, required: ["text"] } } },
  { type: "function", function: { name: "duplicate_file", description: "Duplicate file.", parameters: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } }, required: ["source", "destination"] } } },
  { type: "function", function: { name: "create_folder", description: "Create folder.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "get_project_stats", description: "Stats: files/lines/size.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "todo_scan", description: "Scan TODO/FIXME.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "format_code", description: "Format file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];
