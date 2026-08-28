import React, { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { File, Search } from "lucide-react";
import { useFiles } from "../context/FilesContext.jsx";

export default function FileSwitcher() {
  const { files, openFileTab } = useFiles();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (files.length === 0) return;
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files.length]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function fuzzyScore(path, q) {
    const p = path.toLowerCase();
    let score = 0, pi = 0, qi = 0, consecutive = 0;
    while (pi < p.length && qi < q.length) {
      if (p[pi] === q[qi]) { score += 10 + consecutive*5; consecutive++; qi++; } else { consecutive = 0; if (p[pi] === "/") score += 1; }
      pi++;
    }
    if (qi !== q.length) return -1;
    score += (q.length / p.length) * 10;
    if (p.includes("/" + q)) score += 15;
    return score;
  }
  const results = useMemo(() => {
    if (!query.trim()) return files.slice(0, 30).map(f=>({ file: f, score: 0 }));
    const q = query.toLowerCase();
    const scored = files.map(f => ({ file: f, score: fuzzyScore(f.path, q) })).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score).slice(0, 30);
    if (scored.length) return scored;
    return files.filter((f) => f.path.toLowerCase().includes(q)).slice(0, 30).map(f=>({ file: f, score: 0 }));
  }, [files, query]);
  const previewFile = results[activeIdx]?.file;

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = results[activeIdx]?.file || results[activeIdx];
      if (f) {
        openFileTab(f.path || f.file?.path);
        setOpen(false);
      }
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="palette-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            className="command-palette"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="command-palette-input">
              <Search size={16} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIdx(0);
                }}
                onKeyDown={handleKeyDown}
                placeholder="Быстрый переход к файлу..."
              />
              <kbd>Esc</kbd>
            </div>
            <div style={{ display: "flex", minHeight: 240 }}>
              <div className="command-palette-list" style={{ flex: 1 }}>
                {results.length === 0 && <div className="command-palette-empty">Файлы не найдены</div>}
                {results.map((r, i) => {
                  const f = r.file || r;
                  const q = query.toLowerCase();
                  let display = f.path;
                  if (q && f.path.toLowerCase().includes(q)) {
                    const idx = f.path.toLowerCase().indexOf(q);
                    display = f.path.slice(0, idx) + "<mark>" + f.path.slice(idx, idx+q.length) + "</mark>" + f.path.slice(idx+q.length);
                  }
                  return (
                  <button
                    key={f.path}
                    className={`command-palette-item ${i === activeIdx ? "active" : ""}`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => {
                      openFileTab(f.path);
                      setOpen(false);
                    }}
                  >
                    <File size={14} />
                    <span dangerouslySetInnerHTML={{ __html: display }} className="fuzzy-match" />
                    <span style={{ fontSize: "10px", color: "var(--text-tertiary)", marginLeft: "auto" }}>{r.score ? Math.round(r.score) : ""}</span>
                  </button>
                )})}
              </div>
              {previewFile && (
                <div style={{ width: "42%", borderLeft: "1px solid var(--border-subtle)", padding: 8, overflow: "hidden", background: "var(--bg-1)" }}>
                  <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{previewFile.path}</div>
                  <pre style={{ fontSize: "11px", lineHeight: 1.4, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200, overflow: "hidden", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>{(previewFile.content || "").slice(0, 800)}</pre>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
