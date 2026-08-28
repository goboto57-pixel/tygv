import React, { useMemo } from "react";
import { File, Folder, FolderOpen } from "lucide-react";

function buildTree(files) {
  const root = { name: "", children: {}, isFile: false };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {}, isFile, path: isFile ? f.path : null };
      }
      node = node.children[part];
    });
  }
  return root;
}

function TreeNode({ node, depth, activeFile, onSelect }) {
  const entries = Object.values(node.children).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {entries.map((child) => (
        <div key={child.name + depth}>
          {child.isFile ? (
            <button
              className={`tree-file ${activeFile === child.path ? "active" : ""}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => onSelect(child.path)}
            >
              <File size={13} className="tree-icon" />
              <span>{child.name}</span>
            </button>
          ) : (
            <div>
              <div className="tree-folder" style={{ paddingLeft: 12 + depth * 14 }}>
                <FolderOpen size={13} className="tree-icon tree-icon-folder" />
                <span>{child.name}</span>
              </div>
              <TreeNode node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export default function FileTree({ files, activeFile, onSelect }) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div className="file-tree">
      <div className="file-tree-label">
        <Folder size={13} />
        <span>Проект</span>
        <span className="file-count">{files.length}</span>
      </div>
      <div className="file-tree-list">
        <TreeNode node={tree} depth={0} activeFile={activeFile} onSelect={onSelect} />
      </div>
    </div>
  );
}
