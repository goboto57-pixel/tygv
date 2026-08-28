import React, { memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, MessageSquare, X, Sparkles, PanelLeftClose } from "lucide-react";
import { useSessions } from "../context/SessionsContext.jsx";
import { useUI } from "../context/UIContext.jsx";

function SidebarInner({ open, onClose, isMobile }) {
  const { chatList, chatId, newChat, loadChat } = useSessions();
  const { leftSidebarOpen, setLeftSidebarOpen } = useUI();

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
          {isMobile ? <X size={18} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <button className="btn-new-chat" onClick={handleNewChat}>
        <Plus size={16} />
        Новый проект
      </button>

      <div className="sidebar-section-label">История</div>
      <div className="sidebar-list">
        {chatList.length === 0 && (
          <div className="sidebar-empty">Пока нет сохранённых чатов</div>
        )}
        {chatList.map((c) => (
          <button
            key={c.id}
            className={`sidebar-item ${c.id === chatId ? "active" : ""}`}
            onClick={() => handleLoadChat(c.id)}
          >
            <MessageSquare size={15} className="sidebar-item-icon" />
            <span className="sidebar-item-title">{c.title}</span>
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <span className="model-pill">Mistral · Codestral</span>
      </div>
    </div>
  );

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

export default memo(SidebarInner);
