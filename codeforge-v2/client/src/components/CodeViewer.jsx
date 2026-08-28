import React, { useState, useEffect, useRef } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, GitCompare, Code2, Pencil, Save, X as XIcon } from "lucide-react";
import DiffViewer from "./DiffViewer.jsx";
import { useApp } from "../context/AppContext.jsx";

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
  const { updateFileContent, notify } = useApp();
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState("code"); // 'code' | 'diff'
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content || "");
  const textareaRef = useRef(null);

  useEffect(() => {
    setDraft(content || "");
    setEditing(false);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!path) {
    return <div className="code-viewer code-viewer-empty">Выберите файл слева</div>;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const startEdit = () => {
    setDraft(content || "");
    setEditing(true);
    setMode("code");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const saveEdit = () => {
    updateFileContent(path, draft);
    setEditing(false);
    notify("Файл сохранён", "success");
  };

  const cancelEdit = () => {
    setDraft(content || "");
    setEditing(false);
  };

  const hasDiff = !!prevContent && prevContent !== content;

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <span className="code-viewer-path">{path}</span>
        <div className="code-viewer-header-actions">
          {editing ? (
            <>
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
              <button className="code-viewer-copy" onClick={handleCopy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? "Скопировано" : "Копировать"}
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
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
      ) : mode === "diff" && hasDiff ? (
        <DiffViewer oldContent={prevContent} newContent={content} />
      ) : (
        <div className="code-viewer-body">
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
      )}
    </div>
  );
}
