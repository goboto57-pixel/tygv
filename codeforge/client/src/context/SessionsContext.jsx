import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

const SessionsContext = createContext(null);
const API_BASE = import.meta.env.VITE_API_URL || "/api";

export function SessionsProvider({ children, chatId, files, messages, notify, loadChatList }) {
  const [openSessions, setOpenSessions] = useState(() => [
    { id: chatId, title: "Новая сессия" }
  ]);
  const [chatList, setChatList] = useState([]);
  const [snapshots, setSnapshots] = useState([]);

  const loadChatListCached = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/chats`);
      const data = await res.json();
      setChatList(data.chats || []);
    } catch (e) {
      // silent
    }
  }, []);

  const loadChat = useCallback(async (id) => {
    try {
      const res = await fetch(`${API_BASE}/projects/chats/${id}`);
      if (!res.ok) return notify("Чат не найден", "error");
      const data = await res.json();
      return {
        id: data.id,
        messages: data.messages?.filter((m) => m.role !== "system") || [],
        files: data.files || [],
        title: data.title || "Сессия"
      };
    } catch (e) {
      notify("Не удалось загрузить чат", "error");
      return null;
    }
  }, [notify]);

  const newChat = useCallback(() => {
    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    setOpenSessions((prev) => [...prev, { id, title: "Новая сессия" }]);
    return id;
  }, []);

  const closeSessionTab = useCallback(
    (id) => {
      setOpenSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          const freshId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          return [{ id: freshId, title: "Новая сессия" }];
        }
        return next;
      });
    },
    []
  );

  const renameSessionTab = useCallback((id, title) => {
    setOpenSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  const takeSnapshot = useCallback(async (label) => {
    try {
      const res = await fetch(`${API_BASE}/projects/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, label, files })
      });
      const data = await res.json();
      notify("Снимок версии сохранён", "success");
      return data.id;
    } catch (e) {
      notify("Не удалось создать снимок", "error");
    }
  }, [chatId, files, notify]);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/snapshots/${chatId}`);
      const data = await res.json();
      setSnapshots(data.snapshots || []);
    } catch (e) {
      // silent
    }
  }, [chatId]);

  const restoreSnapshot = useCallback((snapshot) => {
    notify(`Восстановлена версия: ${snapshot.label || "снимок"}`, "success");
    return snapshot.files || [];
  }, [notify]);

  const diffSnapshots = useCallback(async (fromId, toId) => {
    try {
      const params = new URLSearchParams({ from: fromId, to: toId });
      const res = await fetch(`${API_BASE}/projects/git/${chatId}/diff?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      notify("Не удалось получить diff между снимками", "error");
      return null;
    }
  }, [chatId, notify]);

  const value = useMemo(() => ({
    openSessions,
    closeSessionTab,
    renameSessionTab,
    chatList,
    loadChatList: loadChatListCached,
    loadChat,
    newChat,
    snapshots,
    loadSnapshots,
    takeSnapshot,
    restoreSnapshot,
    diffSnapshots,
  }), [
    openSessions,
    closeSessionTab,
    renameSessionTab,
    chatList,
    loadChatListCached,
    loadChat,
    newChat,
    snapshots,
    loadSnapshots,
    takeSnapshot,
    restoreSnapshot,
    diffSnapshots,
  ]);

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessions() {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}