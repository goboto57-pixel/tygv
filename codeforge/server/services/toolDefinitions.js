/**
 * Tool schema exposed to Mistral Codestral via function calling.
 * Mirrors the toolset of Claude Code / OpenCode-style agents.
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
      name: "search_code",
      description: "Search across all project files for a text pattern, returning matching lines with context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or pattern to search for" }
        },
        required: ["query"]
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
        "Simulate running a shell command (e.g. npm install, npm run build) and receive a plausible result. Use only for informational/validation purposes, not for actual execution.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  }
];
