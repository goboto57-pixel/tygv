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

function globToRegExp(glob) {
  // very small glob subset: * (any chars except /), ** (any chars incl /)
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§DOUBLESTAR§")
    .replace(/\*/g, "[^/]*")
    .replace(/§DOUBLESTAR§/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function buildDirectoryTree(fsMap) {
  const root = {};
  for (const path of fsMap.keys()) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (isFile) {
        node.__files = node.__files || [];
        node.__files.push(part);
      } else {
        node[part] = node[part] || {};
        node = node[part];
      }
    });
  }

  function render(node, prefix = "") {
    let lines = [];
    const dirs = Object.keys(node).filter((k) => k !== "__files").sort();
    const files = (node.__files || []).sort();
    dirs.forEach((d) => {
      lines.push(`${prefix}${d}/`);
      lines = lines.concat(render(node[d], prefix + "  "));
    });
    files.forEach((f) => {
      lines.push(`${prefix}${f}`);
    });
    return lines;
  }

  return render(root).join("\n") || "(empty project)";
}

function lintText(path, content) {
  const issues = [];
  const pairs = [
    ["(", ")"],
    ["{", "}"],
    ["[", "]"]
  ];
  for (const [open, close] of pairs) {
    const openCount = (content.match(new RegExp(`\\${open}`, "g")) || []).length;
    const closeCount = (content.match(new RegExp(`\\${close}`, "g")) || []).length;
    if (openCount !== closeCount) {
      issues.push(`Unbalanced '${open}${close}': ${openCount} open vs ${closeCount} close`);
    }
  }
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    if (/\bTODO\b|\bFIXME\b/.test(line)) {
      issues.push(`Line ${idx + 1}: marker found — "${line.trim().slice(0, 100)}"`);
    }
    if (line.length > 200) {
      issues.push(`Line ${idx + 1}: very long line (${line.length} chars)`);
    }
  });
  return issues;
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

    case "list_directory_tree": {
      return { result: buildDirectoryTree(fsMap) };
    }

    case "read_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      return { result: content };
    }

    case "read_files": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const results = {};
      const missing = [];
      for (const p of paths) {
        if (fsMap.has(p)) results[p] = fsMap.get(p);
        else missing.push(p);
      }
      return { result: { files: results, missing } };
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

    case "rename_file": {
      if (!fsMap.has(args.old_path)) {
        return { error: `File not found: ${args.old_path}` };
      }
      if (fsMap.has(args.new_path)) {
        return { error: `Target path already exists: ${args.new_path}` };
      }
      const content = fsMap.get(args.old_path);
      fsMap.delete(args.old_path);
      fsMap.set(args.new_path, content);
      return {
        result: `Renamed ${args.old_path} -> ${args.new_path}`,
        fileDeleted: args.old_path,
        fileChanged: args.new_path
      };
    }

    case "find_files": {
      const re = globToRegExp(args.pattern || "*");
      const matches = Array.from(fsMap.keys()).filter((p) => re.test(p));
      return { result: matches };
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

    case "grep": {
      let re;
      try {
        re = new RegExp(args.pattern, args.flags || "i");
      } catch (e) {
        return { error: `Invalid regular expression: ${e.message}` };
      }
      const matches = [];
      for (const [path, content] of fsMap.entries()) {
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (re.test(line)) {
            matches.push({ path, line: idx + 1, text: line.trim().slice(0, 200) });
          }
        });
      }
      return { result: matches.slice(0, 80) };
    }

    case "make_plan": {
      return { result: { title: args.title, steps: args.steps }, isPlan: true };
    }

    case "run_command": {
      return {
        result: `[simulated] $ ${args.command}\nCommand acknowledged. (Live execution is not enabled in this environment; verify locally.)`,
        terminalCommand: args.command
      };
    }

    case "lint_file": {
      const content = fsMap.get(args.path);
      if (content === undefined) {
        return { error: `File not found: ${args.path}` };
      }
      const issues = lintText(args.path, content);
      return { result: issues.length ? issues : ["No obvious issues found."] };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
