import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FolderTree, Code2, Eye, X, TerminalSquare, PanelRightClose, Columns2, Maximize2, Search, Plus, FilePlus, FolderPlus, BarChart3, Pencil, Trash2, Download } from "lucide-react";
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
  const { files, activeFile, openFileTab, openFiles, closeFileTab, chatId, setFiles } = useFiles();
  const { terminalOpen, setTerminalOpen, terminalLog, notify } = useUI();
  const [tab, setTab] = useState("code"); // 'code' | 'preview'
  const [splitView, setSplitView] = useState(false);
  const [splitFile, setSplitFile] = useState(null);
  const [filter, setFilter] = useState("");

  const hasHtml = useMemo(() => files.some((f) => f.path.endsWith(".html")), [files]);
  const hasPackageJson = useMemo(() => files.some((f) => f.path === "package.json"), [files]);
  const canPreview = hasHtml || hasPackageJson;
  const activeEntry = files.find((f) => f.path === activeFile);
  const breadcrumbs = useMemo(() => activeFile ? activeFile.split("/").filter(Boolean) : [], [activeFile]);

  const filteredFiles = useMemo(() => {
    if (!filter.trim()) return files;
    const q = filter.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, filter]);

  const stats = useMemo(() => {
    const totalBytes = files.reduce((s, f) => s + (f.content?.length || 0), 0);
    const totalLines = files.reduce((s, f) => s + (f.content?.split("\n").length || 0), 0);
    return { totalBytes, totalLines };
  }, [files]);

  const createNewFile = () => {
    const name = prompt("Имя нового файла (например, src/utils.js):");
    if (!name) return;
    const clean = name.replace(/^\/+/, "").trim();
    if (!clean) return;
    if (files.some((f) => f.path === clean)) { notify?.("Файл уже существует", "error"); return; }
    setFiles((prev) => [...prev, { path: clean, content: "" }]);
    openFileTab(clean);
    notify?.(`Создан ${clean}`, "success");
  };
  const createNewFolder = () => {
    const name = prompt("Имя папки (например, src/components):");
    if (!name) return;
    const clean = name.replace(/^\/+/, "").replace(/\/+$/, "").trim();
    if (!clean) return;
    const keep = `${clean}/.keep`;
    if (files.some((f) => f.path === keep)) { notify?.("Папка уже существует", "info"); return; }
    setFiles((prev) => [...prev, { path: keep, content: "" }]);
    notify?.(`Папка ${clean} создана`, "success");
  };
  const renameActive = () => {
    if (!activeFile) { notify?.("Выберите файл", "info"); return; }
    const nv = prompt(`Переименовать ${activeFile} в:`, activeFile);
    if (!nv || nv === activeFile) return;
    const clean = nv.replace(/^\/+/, "").trim();
    if (files.some((f) => f.path === clean)) { notify?.("Файл уже существует", "error"); return; }
    setFiles((prev) => prev.map((f) => f.path === activeFile ? { ...f, path: clean } : f));
    openFileTab(clean);
    notify?.(`Переименован в ${clean}`, "success");
  };
  const deleteActive = () => {
    if (!activeFile) return;
    if (!confirm(`Удалить ${activeFile}?`)) return;
    setFiles((prev) => prev.filter((f) => f.path !== activeFile));
    closeFileTab(activeFile);
    notify?.(`Удалён ${activeFile}`, "success");
  };
  const downloadActive = () => {
    if (!activeFile) return;
    const f = files.find((x) => x.path === activeFile);
    if (!f) return;
    const blob = new Blob([f.content || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = activeFile.split("/").pop(); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const body =
    files.length === 0 ? (
      <div className="files-panel files-panel-empty">
        <FolderTree size={28} strokeWidth={1.5} />
        <p>Файлы проекта появятся здесь, как только агент начнёт их создавать.</p>
        <button className="btn-new-chat" onClick={createNewFile} style={{ marginTop: 12 }}><FilePlus size={14} /> Новый файл</button>
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
        <div className="files-toolbar">
          <div className="files-search">
            <Search size={13} />
            <input placeholder="Поиск файлов…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {filter && <button className="icon-btn" onClick={() => setFilter("")}><X size={12} /></button>}
          </div>
          <div className="files-toolbar-actions">
            <button className="icon-btn" onClick={createNewFile} title="Новый файл"><FilePlus size={14} /></button>
            <button className="icon-btn" onClick={createNewFolder} title="Новая папка"><FolderPlus size={14} /></button>
            <button className="icon-btn" onClick={renameActive} title="Переименовать"><Pencil size={13} /></button>
            <button className="icon-btn" onClick={deleteActive} title="Удалить"><Trash2 size={13} /></button>
            <button className="icon-btn" onClick={downloadActive} title="Скачать файл"><Download size={13} /></button>
          </div>
        </div>

        {tab === "code" ? (
          <div className="files-panel-body">
            <FileTree files={filteredFiles} activeFile={activeFile} onSelect={(p) => {
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
        <div className="files-stats">
          <BarChart3 size={11} /> {files.length} файлов · {stats.totalLines.toLocaleString("ru-RU")} строк · {(stats.totalBytes/1024).toFixed(1)} KB{filter ? ` · фильтр: ${filteredFiles.length}/${files.length}` : ""}
        </div>
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
