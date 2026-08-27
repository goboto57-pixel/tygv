import React, { useState, useMemo } from "react";
import { FolderTree, Code2, Eye } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";
import FileTree from "./FileTree.jsx";
import CodeViewer from "./CodeViewer.jsx";
import LivePreview from "./LivePreview.jsx";

export default function FilesPanel() {
  const { files, activeFile, setActiveFile } = useApp();
  const [tab, setTab] = useState("code"); // 'code' | 'preview'

  const hasHtml = useMemo(() => files.some((f) => f.path.endsWith(".html")), [files]);
  const activeContent = files.find((f) => f.path === activeFile)?.content || "";

  if (files.length === 0) {
    return (
      <div className="files-panel files-panel-empty">
        <FolderTree size={28} strokeWidth={1.5} />
        <p>Файлы проекта появятся здесь, как только агент начнёт их создавать.</p>
      </div>
    );
  }

  return (
    <div className="files-panel">
      <div className="files-panel-header">
        <div className="files-tabs">
          <button className={`files-tab ${tab === "code" ? "active" : ""}`} onClick={() => setTab("code")}>
            <Code2 size={14} /> Код
          </button>
          {hasHtml && (
            <button className={`files-tab ${tab === "preview" ? "active" : ""}`} onClick={() => setTab("preview")}>
              <Eye size={14} /> Превью
            </button>
          )}
        </div>
      </div>

      {tab === "code" ? (
        <div className="files-panel-body">
          <FileTree files={files} activeFile={activeFile} onSelect={setActiveFile} />
          <CodeViewer path={activeFile} content={activeContent} />
        </div>
      ) : (
        <LivePreview files={files} />
      )}
    </div>
  );
}
