import React, { useMemo } from "react";
import { File, Folder, FolderOpen, FileCode, FileJson, FileText, Image as ImageIcon, Braces } from "lucide-react";
function fileIconByExt(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (["js","jsx","ts","tsx"].includes(ext)) return FileCode;
  if (["json","yml","yaml"].includes(ext)) return FileJson;
  if (["md","txt"].includes(ext)) return FileText;
  if (["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return ImageIcon;
  if (["html","css","scss"].includes(ext)) return Braces;
  return File;
}

function buildTree(files) {
  const root = { name: "", children: {}, isFile: false };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
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

function TreeNode({ node, depth, activeFile, onSelect, parentPath }) {
  const entries = Object.values(node.children).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {entries.map((child) => {
        const fullPath = parentPath ? `${parentPath}/${child.name}` : child.name;
        return (
        <div key={fullPath}>
          {child.isFile ? (() => { const Icon = fileIconByExt(child.name); return (
            <button
              className={`tree-file ${activeFile === child.path ? "active" : ""}`}
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => onSelect(child.path)}
            >
              <Icon size={13} className="tree-icon" />
              <span>{child.name}</span>
            </button>
            ); })() : (
            <div>
              <div className="tree-folder" style={{ paddingLeft: 12 + depth * 14 }}>
                <FolderOpen size={13} className="tree-icon tree-icon-folder" />
                <span>{child.name}</span>
              </div>
              <TreeNode node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} parentPath={fullPath} />
            </div>
          )}
        </div>
        );
      })}
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
        <TreeNode node={tree} depth={0} activeFile={activeFile} onSelect={onSelect} parentPath="" />
      </div>
    </div>
  );
}
