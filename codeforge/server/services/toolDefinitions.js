/**
 * Tool schema exposed to Mistral models via function calling.
 * Mirrors and extends the toolset of Claude Code / OpenCode-style agents.
 */
export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List all files currently in the project's virtual file tree, with their paths and sizes.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory_tree",
      description:
        "Get a formatted directory tree view of the whole project (folders and files), useful for understanding project structure before making changes.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full contents of a file in the project by its path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. src/index.js" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_files",
      description:
        "Read the full contents of multiple files at once. More efficient than calling read_file repeatedly when you need several files.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" }, description: "List of relative file paths" }
        },
        required: ["paths"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or fully overwrite an existing file with new content. Use for new files or large rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "Full file content" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Apply a precise find-and-replace edit to an existing file. Prefer this over write_file for small changes to avoid rewriting whole files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string", description: "Exact existing text to find (must be unique)" },
          new_text: { type: "string", description: "Replacement text" }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a file to a new path within the project.",
      parameters: {
        type: "object",
        properties: {
          old_path: { type: "string" },
          new_path: { type: "string" }
        },
        required: ["old_path", "new_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find files by name pattern (glob-like, supports * wildcard) across the whole project, e.g. '*.test.js' or 'components/*.jsx'.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob-like pattern, e.g. '*.jsx' or 'src/**/*.css'" }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "Search across all project files for a plain text pattern, returning matching lines with context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search across all project files using a JavaScript-flavored regular expression. More powerful than search_code for structural or pattern-based searches (e.g. function signatures, imports).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression pattern (without slashes)" },
          flags: { type: "string", description: "Regex flags, e.g. 'i' for case-insensitive. Defaults to 'i'." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "make_plan",
      description:
        "Produce a structured step-by-step execution plan BEFORE writing any code. Must be called first for any non-trivial task. The user will review and approve this plan.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the task" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" }
              },
              required: ["title", "description"]
            }
          }
        },
        required: ["title", "steps"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Actually execute a shell command against the current project files in a scoped, best-effort sandboxed temp directory (not a full container — no network egress guarantees, same-host process). Only these binaries are allowed: npm, npx, node, yarn, pnpm, python3, python, pip, pip3, git, ls, cat, echo, mkdir, pytest, jest, vitest, eslint, tsc. No shell operators (&&, |, ;, backticks, $()) — one plain command per call. Files created/modified by the command (e.g. npm init, test output, build artifacts under 1MB) are synced back into the project. Has a timeout (default 60s, max 180s) and truncates very large output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number", description: "Optional. Max wall-clock time in ms before the process is killed. Default 60000, hard cap 180000." }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "semantic_search",
      description:
        "Search the codebase by meaning rather than exact text, using embeddings (Mistral mistral-embed). Use this for conceptual questions grep/search_code can't answer well — e.g. 'where is auth handled', 'code that validates user input', 'the component that renders the sidebar' — when you don't know the exact string/identifier to grep for. Returns the most relevant code chunks ranked by similarity, with file path, line range, and a relevance score (0-1).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of what you're looking for" },
          limit: { type: "number", description: "Max results to return (default 8, max 20)" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description:
        "Auto-detect and run the project's test suite (npm test / jest / vitest / pytest, based on package.json and test file naming) inside the same sandbox as run_command. Returns a parsed pass/fail summary plus full output. Use this instead of a manual run_command call whenever you need to check whether tests pass — after writing new tests or changing code that has existing test coverage.",
      parameters: {
        type: "object",
        properties: {
          timeout_ms: { type: "number", description: "Optional. Max wall-clock time in ms. Default 60000, hard cap 180000." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lint_file",
      description:
        "Run a lightweight static check on a file (unbalanced brackets/quotes, obvious syntax issues, TODO/FIXME markers) and report any problems found.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  }
];
