import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Camera,
  Download,
  Settings,
  Search,
  MessageSquare,
  FileCode,
  CornerDownLeft
} from "lucide-react";
import { useFiles } from "../context/FilesContext.jsx";
import { useSessions } from "../context/SessionsContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import { exportZip } from "../utils/exportZip.js";

// Subsequence fuzzy match (VSCode-palette style): every query char must
// appear in order in the target string. Score rewards earlier matches and
// contiguous runs so "chin.js" beats "chat-input.js:9999" for query "chin".
function fuzzyMatch(query, target) {
  if (!query) return { match: true, score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  const positions = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      positions.push(ti);
      score += 10 - Math.min(ti, 9); // earlier matches score higher
      score += streak * 4; // reward consecutive matches
      streak++;
      qi++;
    } else {
      streak = 0;
    }
  }
  return { match: qi === q.length, score, positions };
}

function highlight(label, positions) {
  if (!positions.length) return label;
  const posSet = new Set(positions);
  return label.split("").map((ch, i) =>
    posSet.has(i) ? (
      <mark key={i}>{ch}</mark>
    ) : (
      ch
    )
  );
}

export default function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUI();
  const { files, chatId, openFileTab } = useFiles();
  const { takeSnapshot, chatList, loadChat, newChat } = useSessions();
  const { setSettingsOpen } = useUI();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [history, setHistory] = useState(() => { try { return JSON.parse(localStorage.getItem("cf_cmd_history")||"[]"); } catch { return []; } });
  const inputRef = useRef(null);
  const addHistory = (id) => {
    setHistory(prev => {
      const next = [id, ...prev.filter(x=>x!==id)].slice(0, 12);
      try { localStorage.setItem("cf_cmd_history", JSON.stringify(next)); } catch {}
      return next;
    });
  };

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [commandPaletteOpen]);

  const actions = useMemo(() => {
    const base = [
      { id: "new", icon: Plus, label: "Новая сессия", group: "Действия", run: () => newChat() },
      {
        id: "snapshot",
        icon: Camera,
        label: "Сохранить снимок версии",
        group: "Действия",
        run: () => takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`, files),
        disabled: files.length === 0
      },
      {
        id: "export",
        icon: Download,
        label: "Скачать проект (.zip)",
        group: "Действия",
        run: () => exportZip(files, `codeforge-${chatId.slice(0, 8)}`),
        disabled: files.length === 0
      },
      { id: "settings", icon: Settings, label: "Открыть настройки", group: "Действия", run: () => setSettingsOpen(true) }
    ];
    const chats = chatList.map((c) => ({
      id: `chat-${c.id}`,
      icon: MessageSquare,
      label: `Открыть сессию: ${c.title}`,
      group: "Сессии",
      run: () => loadChat(c.id)
    }));
    const fileActions = files.map((f) => ({
      id: `file-${f.path}`,
      icon: FileCode,
      label: f.path,
      group: "Файлы",
      run: () => openFileTab(f.path)
    }));

    // Boost history items
    const histSet = new Set(history);
    const all = [...base, ...fileActions, ...chats].map(a => ({ ...a, histBoost: histSet.has(a.id) ? 50 : 0 }));

    if (!query.trim()) {
      const sorted = [...all].sort((a,b)=> (b.histBoost - a.histBoost));
      // show recent history first when no query
      const histItems = sorted.filter(a=>a.histBoost).slice(0,5);
      const rest = sorted.filter(a=>!a.histBoost);
      return [...histItems, ...rest].map((a) => ({ ...a, positions: [] }));
    }

    const scored = all
      .map((a) => ({ ...a, ...fuzzyMatch(query, a.label), score: fuzzyMatch(query, a.label).score + (a.histBoost||0) }))
      .filter((a) => a.match);
    // Stable-ish ordering: best fuzzy score first, ties broken by original
    // group order (actions > files > sessions) via index in `all`.
    const indexOf = new Map(all.map((a, i) => [a.id, i]));
    scored.sort((a, b) => b.score - a.score || indexOf.get(a.id) - indexOf.get(b.id));
    return scored.slice(0, 50);
  }, [query, newChat, takeSnapshot, files, chatId, chatList, loadChat, openFileTab, setSettingsOpen, history]);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((o) => !o);
      }
      if (e.key === "Escape") setCommandPaletteOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandPaletteOpen]);

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, actions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = actions[activeIdx];
      if (a && !a.disabled) {
        addHistory(a.id);
        a.run();
        setCommandPaletteOpen(false);
      }
    }
  };

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <>
          <motion.div
            className="palette-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setCommandPaletteOpen(false)}
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
                placeholder="Команда, файл или сессия... (fuzzy-поиск)"
              />
              <kbd>Esc</kbd>
            </div>
            <div className="command-palette-list">
              {actions.length === 0 && <div className="command-palette-empty">Ничего не найдено</div>}
              {actions.map((a, i, arr) => {
                const showGroupHeader = a.group && (i === 0 || arr[i - 1].group !== a.group);
                return (
                  <React.Fragment key={a.id}>
                    {showGroupHeader && <div className="command-palette-group">{a.group}</div>}
                    <button
                      className={`command-palette-item ${i === activeIdx ? "active" : ""} ${a.disabled ? "disabled" : ""}`}
                      disabled={a.disabled}
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => {
                        addHistory(a.id);
                        a.run();
                        setCommandPaletteOpen(false);
                      }}
                    >
                      <a.icon size={15} />
                      <span>{a.positions?.length ? highlight(a.label, a.positions) : a.label}</span>
                      {i === activeIdx && <CornerDownLeft size={13} className="command-palette-enter" />}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
