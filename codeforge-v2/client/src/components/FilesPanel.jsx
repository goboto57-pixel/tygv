import React, { useState, useMemo } from "react";
import { FolderTree, Code2, Eye, X, TerminalSquare } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";
import FileTree from "./FileTree.jsx";
import CodeViewer from "./CodeViewer.jsx";
import LivePreview from "./LivePreview.jsx";
import TerminalPanel from "./TerminalPanel.jsx";

function fileIcon(path) {
  return path.split("/").pop();
}

export default function FilesPanel() {
  const { files, activeFile, openFileTab, openFiles, closeFileTab, terminalOpen, setTerminalOpen, terminalLog } =
    useApp();
  const [tab, setTab] = useState("code"); // 'code' | 'preview'

  const hasHtml = useMemo(() => files.some((f) => f.path.endsWith(".html")), [files]);
  const activeEntry = files.find((f) => f.path === activeFile);

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
        <button
          className={`files-tab files-tab-terminal ${terminalOpen ? "active" : ""}`}
          onClick={() => setTerminalOpen(!terminalOpen)}
        >
          <TerminalSquare size={14} /> Терминал
          {terminalLog.length > 0 && <span className="file-count">{terminalLog.length}</span>}
        </button>
      </div>

      {tab === "code" ? (
        <div className="files-panel-body">
          <FileTree files={files} activeFile={activeFile} onSelect={openFileTab} />
          <div className="editor-area">
            {openFiles.length > 0 && (
              <div className="editor-tabs">
                {openFiles.map((p) => (
                  <div
                    key={p}
                    className={`editor-tab ${p === activeFile ? "active" : ""}`}
                    onClick={() => openFileTab(p)}
                  >
                    <span className="editor-tab-name">{fileIcon(p)}</span>
                    <button
                      className="editor-tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeFileTab(p);
                      }}
                      aria-label="Закрыть файл"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <CodeViewer path={activeFile} content={activeEntry?.content || ""} prevContent={activeEntry?.prevContent} />
            <TerminalPanel />
          </div>
        </div>
      ) : (
        <LivePreview files={files} />
      )}
    </div>
  );
}
