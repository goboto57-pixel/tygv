import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderTree, Code2, Eye, X, TerminalSquare, PanelRightClose, Columns2, Maximize2 } from "lucide-react";
import { useFiles } from "../context/FilesContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import FileTree from "./FileTree.jsx";
import CodeViewer from "./CodeViewer.jsx";
import LivePreview from "./LivePreview.jsx";
import WebContainerPreview from "./WebContainerPreview.jsx";
import TerminalPanel from "./TerminalPanel.jsx";

function fileIcon(path) {
  return path.split("/").pop();
}

export default function FilesPanel({ open, onClose, isMobile, mobileVisible }) {
  const { files, activeFile, openFileTab, openFiles, closeFileTab, chatId } = useFiles();
  const { terminalOpen, setTerminalOpen, terminalLog } = useUI();
  const [tab, setTab] = useState("code"); // 'code' | 'preview'
  const [splitView, setSplitView] = useState(false);
  const [splitFile, setSplitFile] = useState(null);

  const hasHtml = useMemo(() => files.some((f) => f.path.endsWith(".html")), [files]);
  const hasPackageJson = useMemo(() => files.some((f) => f.path === "package.json"), [files]);
  const canPreview = hasHtml || hasPackageJson;
  const activeEntry = files.find((f) => f.path === activeFile);
  const breadcrumbs = useMemo(() => activeFile ? activeFile.split("/").filter(Boolean) : [], [activeFile]);

  const body =
    files.length === 0 ? (
      <div className="files-panel files-panel-empty">
        <FolderTree size={28} strokeWidth={1.5} />
        <p>Файлы проекта появятся здесь, как только агент начнёт их создавать.</p>
      </div>
    ) : (
      <div className="files-panel">
        <div className="files-panel-header">
          <div className="files-tabs">
            <button className={`files-tab ${tab === "code" ? "active" : ""}`} onClick={() => setTab("code")}>
              <Code2 size={14} /> Код
            </button>
            {canPreview && (
              <button className={`files-tab ${tab === "preview" ? "active" : ""}`} onClick={() => setTab("preview")}>
                <Eye size={14} /> Превью
              </button>
            )}
            <button
              className={`files-tab files-tab-terminal ${terminalOpen ? "active" : ""}`}
              onClick={() => setTerminalOpen(!terminalOpen)}
            >
              <TerminalSquare size={14} /> Терминал
              {terminalLog.length > 0 && <span className="file-count">{terminalLog.length}</span>}
            </button>
          </div>
          <button className="icon-btn files-panel-close-btn" onClick={onClose} aria-label="Закрыть панель файлов">
            {isMobile ? <X size={17} /> : <PanelRightClose size={16} />}
          </button>
        </div>

        {tab === "code" ? (
          <div className="files-panel-body">
            <FileTree files={files} activeFile={activeFile} onSelect={(p) => {
              if (splitView && activeFile && p !== activeFile) setSplitFile(p);
              else openFileTab(p);
            }} />
            <div className="editor-area">
              {breadcrumbs.length > 0 && (
                <div className="breadcrumbs">
                  {breadcrumbs.map((part, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <span className="sep">/</span>}
                      <span onClick={() => {
                        const path = breadcrumbs.slice(0, i+1).join("/");
                        // if intermediate is directory, do nothing, if file exists open it
                        const match = files.find(f=>f.path===path);
                        if (match) openFileTab(path);
                      }}>{part}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
              {openFiles.length > 0 && (
                <div className="editor-tabs">
                  {openFiles.map((p) => (
                    <div
                      key={p}
                      className={`editor-tab ${p === activeFile ? "active" : ""}`}
                      onClick={() => openFileTab(p)}
                      onDoubleClick={() => { if (!splitView && openFiles.length > 1) { setSplitView(true); setSplitFile(p !== activeFile ? p : openFiles.find(x=>x!==activeFile)); }}}
                      title="Двойной клик для split view"
                    >
                      <span className="editor-tab-name">{fileIcon(p)}</span>
                      <button
                        className="editor-tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeFileTab(p);
                          if (splitFile === p) setSplitFile(null);
                        }}
                        aria-label="Закрыть файл"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  <button className={`editor-tab ${splitView ? "active" : ""}`} onClick={() => setSplitView(v=>!v)} title="Split view">
                    <Columns2 size={12} />
                  </button>
                </div>
              )}
              {splitView && splitFile ? (
                <div className="editor-split">
                  <div className="editor-split-pane">
                    <CodeViewer path={activeFile} content={activeEntry?.content || ""} prevContent={activeEntry?.prevContent} />
                  </div>
                  <div className="editor-split-divider" />
                  <div className="editor-split-pane">
                    {(() => { const e = files.find(f=>f.path===splitFile); return <CodeViewer path={splitFile} content={e?.content||""} />; })()}
                    <button className="editor-split-close" onClick={()=>setSplitView(false)}><X size={12}/></button>
                  </div>
                </div>
              ) : (
                <CodeViewer path={activeFile} content={activeEntry?.content || ""} prevContent={activeEntry?.prevContent} />
              )}
              <TerminalPanel />
            </div>
          </div>
        ) : (
          hasPackageJson ? <WebContainerPreview files={files} key={chatId} /> : <LivePreview files={files} activeFile={activeFile} />
        )}
      </div>
    );

  if (isMobile) {
    if (!mobileVisible) return null;
    return body;
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="sidebar-overlay right-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="files-panel-wrap"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            {body}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
