import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, GitCompare, Code2, Pencil, Save, X as XIcon, AlertTriangle, Maximize2, Map } from "lucide-react";
import DiffViewer from "./DiffViewer.jsx";
import { useFiles } from "../context/FilesContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import { lintTextClient } from "../utils/lintClient.js";

function getLanguage(path) {
  if (!path) return "text";
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    js: "jsx", jsx: "jsx", ts: "tsx", tsx: "tsx", py: "python", java: "java",
    go: "go", rs: "rust", rb: "ruby", php: "php", c: "c", cpp: "cpp",
    cs: "csharp", html: "markup", css: "css", scss: "scss", json: "json",
    md: "markdown", yml: "yaml", yaml: "yaml", sql: "sql", sh: "bash"
  };
  return map[ext] || "text";
}

export default function CodeViewer({ path, content, prevContent }) {
  const { updateFileContent } = useFiles();
  const { notify } = useUI();
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState("code");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content || "");
  const [saveState, setSaveState] = useState("idle");
  const [originalContent, setOriginalContent] = useState(content || "");
  const textareaRef = useRef(null);
  const autosaveTimer = useRef(null);
  const savedTimer = useRef(null);

  useEffect(() => {
    setDraft(content || "");
    setOriginalContent(content || "");
    setEditing(false);
    setSaveState("idle");
    clearTimeout(autosaveTimer.current);
    clearTimeout(savedTimer.current);
  }, [path, content]);

  // Debounced autosave: commits the draft 800ms after the user stops typing
  useEffect(() => {
    if (!editing) return undefined;
    if (draft === originalContent) {
      setSaveState("idle");
      return undefined;
    }
    setSaveState("pending");
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      updateFileContent(path, draft);
      setOriginalContent(draft);
      setSaveState("saved");
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveState("idle"), 1500);
    }, 800);
    return () => clearTimeout(autosaveTimer.current);
  }, [draft, editing, path, updateFileContent]);

  useEffect(() => {
    return () => {
      clearTimeout(autosaveTimer.current);
      clearTimeout(savedTimer.current);
    };
  }, []);

  if (!path) {
    return <div className="code-viewer code-viewer-empty">Выберите файл слева</div>;
  }

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = content || "";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      ta.remove();
    }
  }, [content]);

  const startEdit = useCallback(() => {
    setDraft(content || "");
    setOriginalContent(content || "");
    setEditing(true);
    setMode("code");
    setSaveState("idle");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [content]);

  const saveEdit = useCallback(() => {
    clearTimeout(autosaveTimer.current);
    updateFileContent(path, draft);
    setOriginalContent(draft);
    setEditing(false);
    setSaveState("idle");
    notify("Файл сохранён", "success");
  }, [path, draft, updateFileContent, notify]);

  const cancelEdit = useCallback(() => {
    clearTimeout(autosaveTimer.current);
    setDraft(originalContent);
    setEditing(false);
    setSaveState("idle");
  }, [originalContent]);

  const hasDiff = !!prevContent && prevContent !== content;

  // Real-time lint of whatever's currently on screen
  const lintTarget = editing ? draft : content;
  const lintIssues = useMemo(() => lintTextClient(lintTarget), [lintTarget]);

  const [showMinimap, setShowMinimap] = useState(false);
  const minimapContent = useMemo(() => {
    if (!content) return "";
    return content.slice(0, 2000).replace(/\t/g, "  ");
  }, [content]);

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <span className="code-viewer-path">{path}</span>
        <div className="code-viewer-header-actions">
          {lintIssues.length > 0 && (
            <span className="code-viewer-lint-badge" title={lintIssues.map((i) => i.text).join("; ")}>
              <AlertTriangle size={12} />
              {lintIssues.length}
            </span>
          )}
          {editing ? (
            <>
              <span className={`code-viewer-save-status code-viewer-save-status-${saveState}`}>
                {saveState === "pending" ? "Сохранение…" : saveState === "saved" ? "Сохранено автоматически" : ""}
              </span>
              <button className="code-viewer-copy code-viewer-save" onClick={saveEdit}>
                <Save size={13} /> Сохранить
              </button>
              <button className="code-viewer-copy" onClick={cancelEdit}>
                <XIcon size={13} /> Отмена
              </button>
            </>
          ) : (
            <>
              {hasDiff && (
                <div className="code-viewer-mode-switch">
                  <button
                    className={mode === "code" ? "active" : ""}
                    onClick={() => setMode("code")}
                    title="Показать код"
                  >
                    <Code2 size={13} />
                  </button>
                  <button
                    className={mode === "diff" ? "active" : ""}
                    onClick={() => setMode("diff")}
                    title="Показать изменения"
                  >
                    <GitCompare size={13} />
                  </button>
                </div>
              )}
              <button className="code-viewer-copy" onClick={startEdit} title="Редактировать файл">
                <Pencil size={13} /> Изменить
              </button>
              <button className="code-viewer-copy" onClick={() => setShowMinimap(v=>!v)} title="Minimap">
                <Maximize2 size={13} />
              </button>
              <button className="code-viewer-copy" onClick={handleCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Скопировано" : "Копировать"}
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <>
          {lintIssues.length > 0 && (
            <div className="code-viewer-lint-list">
              {lintIssues.slice(0, 8).map((issue, i) => (
                <div key={i} className="code-viewer-lint-item">
                  <AlertTriangle size={11} />
                  {issue.line != null && <span className="code-viewer-lint-line">строка {issue.line}</span>}
                  <span>{issue.text}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="code-editor-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                saveEdit();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const el = e.target;
                const start = el.selectionStart;
                const end = el.selectionEnd;
                const next = draft.slice(0, start) + "  " + draft.slice(end);
                setDraft(next);
                requestAnimationFrame(() => {
                  el.selectionStart = el.selectionEnd = start + 2;
                });
              }
            }}
          />
        </>
      ) : mode === "diff" && hasDiff ? (
        <DiffViewer oldContent={prevContent} newContent={content} />
      ) : (
        <div className="code-viewer-wrap">
          <div className="code-viewer-body" style={{ flex: 1 }}>
            <SyntaxHighlighter
              language={getLanguage(path)}
              style={vscDarkPlus}
              showLineNumbers
              customStyle={{
                margin: 0,
                background: "transparent",
                fontSize: "13px",
                padding: "16px",
                fontFamily: "JetBrains Mono, monospace"
              }}
            >
              {content || ""}
            </SyntaxHighlighter>
          </div>
          {showMinimap && (
            <div className="code-viewer-minimap" onClick={()=>setShowMinimap(false)} title="Нажми чтобы скрыть">
              {minimapContent.split("\n").slice(0, 80).map((line, i) => (
                <div key={i} style={{ opacity: line.trim() ? 0.8 : 0.3, height: "2px", overflow: "hidden" }}>{line.slice(0, 60)}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
