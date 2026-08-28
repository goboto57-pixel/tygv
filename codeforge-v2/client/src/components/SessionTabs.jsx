import React from "react";
import { Plus, X, MessageSquareText } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

export default function SessionTabs() {
  const { openSessions, chatId, loadChat, newChat, closeSessionTab } = useApp();

  return (
    <div className="session-tabs">
      <div className="session-tabs-scroll">
        {openSessions.map((s) => (
          <div
            key={s.id}
            className={`session-tab ${s.id === chatId ? "active" : ""}`}
            onClick={() => s.id !== chatId && loadChat(s.id)}
          >
            <MessageSquareText size={13} className="session-tab-icon" />
            <span className="session-tab-title">{s.title}</span>
            <button
              className="session-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeSessionTab(s.id);
              }}
              aria-label="Закрыть сессию"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <button className="session-tab-add" onClick={() => newChat()} title="Новая сессия" aria-label="Новая сессия">
        <Plus size={16} />
      </button>
    </div>
  );
}
