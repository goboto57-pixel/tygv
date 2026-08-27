/**
 * In-memory virtual project file system.
 * Each project's state is held per-request (passed in from client, persisted via Cloudinary between turns).
 */

export function createFSFromFiles(files = []) {
  // files: [{ path, content }]
  const map = new Map();
  for (const f of files) map.set(f.path, f.content);
  return map;
}

export function fsToArray(fsMap) {
  return Array.from(fsMap.entries()).map(([path, content]) => ({ path, content }));
}

export function executeTool(toolName, args, fsMap) {
  switch (toolName) {
    case "list_files": {
      const list = Array.from(fsMap.entries()).map(([path, content]) => ({
        path,
        size: content.length
      }));
      return { result: list };
    }

    case "read_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      return { result: content };
    }

    case "write_file": {
      const existed = fsMap.has(args.path);
      fsMap.set(args.path, args.content);
      return { result: `${existed ? "Updated" : "Created"} file: ${args.path}`, fileChanged: args.path };
    }

    case "edit_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      const occurrences = content.split(args.old_text).length - 1;
      if (occurrences === 0) {
        return { error: `old_text not found in ${args.path}` };
      }
      if (occurrences > 1) {
        return { error: `old_text is not unique in ${args.path} (${occurrences} matches). Provide more context.` };
      }
      const newContent = content.replace(args.old_text, args.new_text);
      fsMap.set(args.path, newContent);
      return { result: `Edited file: ${args.path}`, fileChanged: args.path };
    }

    case "delete_file": {
      if (!fsMap.has(args.path)) {
        return { error: `File not found: ${args.path}` };
      }
      fsMap.delete(args.path);
      return { result: `Deleted file: ${args.path}`, fileDeleted: args.path };
    }

    case "search_code": {
      const matches = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (line.toLowerCase().includes(args.query.toLowerCase())) {
            matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
      return { result: matches.slice(0, 50) };
    }

    case "make_plan": {
      return { result: { title: args.title, steps: args.steps }, isPlan: true };
    }

    case "run_command": {
      return {
        result: `[simulated] $ ${args.command}\nCommand acknowledged. (Live execution is not enabled in this environment; verify locally.)`
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
