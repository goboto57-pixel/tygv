import React, { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check } from "lucide-react";

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

export default function CodeViewer({ path, content }) {
  const [copied, setCopied] = useState(false);

  if (!path) {
    return <div className="code-viewer code-viewer-empty">Выберите файл слева</div>;
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-viewer">
      <div className="code-viewer-header">
        <span className="code-viewer-path">{path}</span>
        <button className="code-viewer-copy" onClick={handleCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
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
    </div>
  );
}
