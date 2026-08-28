import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  Camera,
  Download,
  Settings,
  Search,
  MessageSquare,
  Trash2,
  CornerDownLeft
} from "lucide-react";
import { useApp } from "../context/AppContext.jsx";
import { exportZip } from "../utils/exportZip.js";

export default function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    newChat,
    takeSnapshot,
    files,
    chatId,
    chatList,
    loadChat,
    setSettingsOpen
  } = useApp();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setActiveIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [commandPaletteOpen]);

  const actions = useMemo(() => {
    const base = [
      { id: "new", icon: Plus, label: "Новая сессия", run: () => newChat() },
      {
        id: "snapshot",
        icon: Camera,
        label: "Сохранить снимок версии",
        run: () => takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`),
        disabled: files.length === 0
      },
      {
        id: "export",
        icon: Download,
        label: "Скачать проект (.zip)",
        run: () => exportZip(files, `codeforge-${chatId.slice(0, 8)}`),
        disabled: files.length === 0
      },
      { id: "settings", icon: Settings, label: "Открыть настройки", run: () => setSettingsOpen(true) }
    ];
    const chats = chatList.map((c) => ({
      id: `chat-${c.id}`,
      icon: MessageSquare,
      label: `Открыть сессию: ${c.title}`,
      run: () => loadChat(c.id)
    }));
    const all = [...base, ...chats];
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter((a) => a.label.toLowerCase().includes(q));
  }, [query, newChat, takeSnapshot, files, chatId, chatList, loadChat, setSettingsOpen]);

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
                placeholder="Команда или поиск по сессиям..."
              />
              <kbd>Esc</kbd>
            </div>
            <div className="command-palette-list">
              {actions.length === 0 && <div className="command-palette-empty">Ничего не найдено</div>}
              {actions.map((a, i) => (
                <button
                  key={a.id}
                  className={`command-palette-item ${i === activeIdx ? "active" : ""} ${a.disabled ? "disabled" : ""}`}
                  disabled={a.disabled}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => {
                    a.run();
                    setCommandPaletteOpen(false);
                  }}
                >
                  <a.icon size={15} />
                  <span>{a.label}</span>
                  {i === activeIdx && <CornerDownLeft size={13} className="command-palette-enter" />}
                </button>
              ))}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
