import React, { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, MessageSquare, X, Sparkles, PanelLeftClose, Search, Trash2, Check } from "lucide-react";
import { useSessions } from "../context/SessionsContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import { useSettings } from "../context/SettingsContext.jsx";

export default function Sidebar({ open, onClose, isMobile }) {
  const { chatList, chatId, newChat, loadChat, deleteChat } = useSessions();
  const { leftSidebarOpen, setLeftSidebarOpen } = useUI();
  const { settings, MODELS } = useSettings();
  const activeModel = MODELS.find((m) => m.id === settings.model);
  const [filter, setFilter] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  // Auto-reset the "confirm delete" state after a few seconds — needed for
  // mobile where there's no mouseleave to fall back on.
  React.useEffect(() => {
    if (!pendingDeleteId) return;
    const t = setTimeout(() => setPendingDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [pendingDeleteId]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chatList;
    return chatList.filter((c) => (c.title || "").toLowerCase().includes(q));
  }, [chatList, filter]);

  const handleNewChat = () => {
    newChat();
    setLeftSidebarOpen(false);
  };

  const handleLoadChat = (id) => {
    loadChat(id);
    setLeftSidebarOpen(false);
  };

  const content = (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">
          <Sparkles size={18} strokeWidth={2.2} />
        </div>
        <div className="brand-text">
          <span className="brand-name">CodeForge</span>
          <span className="brand-sub">multi-agent studio</span>
        </div>
        <button className="icon-btn sidebar-close-btn" onClick={onClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </div>

      <button className="btn-new-chat" onClick={handleNewChat}>
        <Plus size={16} />
        Новый проект
      </button>

      <div className="sidebar-search">
        <Search size={13} />
        <input placeholder="Поиск по чатам…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="sidebar-section-label">История</div>
      <div className="sidebar-list">
        {chatList.length === 0 && (
          <div className="sidebar-empty">Пока нет сохранённых чатов</div>
        )}
        {filtered.map((c) => (
          <div key={c.id} className={`sidebar-item-row ${c.id === chatId ? "active" : ""}`}>
            <button
              className="sidebar-item"
              onClick={() => handleLoadChat(c.id)}
            >
              <MessageSquare size={15} className="sidebar-item-icon" />
              <span className="sidebar-item-title">{c.title}</span>
            </button>
            {pendingDeleteId === c.id ? (
              <button
                className="sidebar-item-delete-btn confirm"
                title="Подтвердить удаление"
                aria-label="Подтвердить удаление чата"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDeleteId(null);
                  deleteChat(c.id);
                }}
                onMouseLeave={() => setPendingDeleteId(null)}              >
                <Check size={14} />
              </button>
            ) : (
              <button
                className="sidebar-item-delete-btn"
                title="Удалить чат"
                aria-label="Удалить чат"
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDeleteId(c.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {filter.trim() && filtered.length === 0 && <div className="sidebar-empty">Ничего не найдено</div>}
      </div>

      <div className="sidebar-footer">
        <span className="model-pill">{activeModel ? `${activeModel.provider} · ${activeModel.label}` : settings.model}</span>
      </div>
    </div>
  );

  // Desktop: inline sidebar, no overlay/drawer
  if (!isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <motion.div
            className="sidebar-desktop-wrap"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "var(--sidebar-w)", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ flexShrink: 0, overflow: "hidden" }}
          >
            <div style={{ width: "var(--sidebar-w)", height: "100%" }}>{content}</div>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // Mobile: overlay + drawer
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="sidebar-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="sidebar-mobile-wrap"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          >
            {content}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
