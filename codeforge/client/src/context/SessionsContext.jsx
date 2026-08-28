import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "./uuid.js";

const SessionsContext = createContext(null);
const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ACTIVE_CHAT_KEY = "codeforge_active_chat";
const OPEN_SESSIONS_KEY = "codeforge_open_sessions";

function makeNewSession() {
  const id = `chat_${uuid()}`;
  return { id, title: "Новая сессия", messages: [], uiMessages: [], files: [], localOnly: true };
}

function readStoredOpenSessions() {
  try {
    const raw = localStorage.getItem(OPEN_SESSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s) => s?.id) : [];
  } catch {
    return [];
  }
}

export function SessionsProvider({ children, notify }) {
  const [chatList, setChatList] = useState([]);
  const [openSessions, setOpenSessions] = useState(() => readStoredOpenSessions());
  const [activeChatId, setActiveChatId] = useState(() => {
    try {
      return localStorage.getItem(ACTIVE_CHAT_KEY) || null;
    } catch {
      return null;
    }
  });
  const [activeSession, setActiveSession] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [ready, setReady] = useState(false);
  const loadingRef = useRef(new Map());

  useEffect(() => {
    try {
      if (activeChatId) localStorage.setItem(ACTIVE_CHAT_KEY, activeChatId);
      localStorage.setItem(OPEN_SESSIONS_KEY, JSON.stringify(openSessions.slice(-12)));
    } catch {
      // local persistence is best-effort; server storage remains the source of truth.
    }
  }, [activeChatId, openSessions]);

  const loadChatList = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/projects/chats`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const chats = Array.isArray(data.chats) ? data.chats : [];
      setChatList(chats);

      setOpenSessions((prev) => {
        const known = new Map(chats.map((c) => [c.id, c]));
        const storedActive = (() => { try { return localStorage.getItem(ACTIVE_CHAT_KEY); } catch { return null; } })();
        const currentActive = activeChatId || storedActive;
        const merged = prev.map((s) => known.has(s.id) ? { ...s, ...known.get(s.id), localOnly: false } : s);
        const localActive = merged.find((s) => s.id === currentActive);
        const activeStillExists = currentActive && (known.has(currentActive) || localActive?.localOnly === true);
        if (!activeStillExists && chats[0]?.id) {
          setActiveChatId(chats[0].id);
          return [{ id: chats[0].id, title: chats[0].title }, ...merged.filter((s) => s.id !== chats[0].id)].slice(-12);
        }
        if (currentActive && !activeChatId) setActiveChatId(currentActive);
        return merged;
      });
      return chats;
    } catch (e) {
      // A cached/local session is still usable when the API is temporarily unavailable.
      notify?.("Сервер истории недоступен — использую локальный кэш", "info");
      return [];
    } finally {
      setReady(true);
    }
  }, [activeChatId, notify]);

  useEffect(() => {
    loadChatList();
  }, [loadChatList]);

  const loadChat = useCallback(async (id) => {
    if (!id) return null;
    if (loadingRef.current.has(id)) return loadingRef.current.get(id);

    const promise = (async () => {
      try {
        const res = await fetch(`${API_BASE}/projects/chats/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const session = {
          id: data.id || id,
          title: data.title || data.uiMessages?.find((m) => m.role === "user")?.content?.slice(0, 60) || "Сессия",
          messages: Array.isArray(data.messages) ? data.messages : [],
          uiMessages: Array.isArray(data.uiMessages) ? data.uiMessages : [],
          files: Array.isArray(data.files) ? data.files : [],
          updatedAt: data.updatedAt,
          localOnly: false,
        };
        setActiveChatId(session.id);
        setActiveSession(session);
        setOpenSessions((prev) => {
          const without = prev.filter((s) => s.id !== session.id);
          return [...without, { id: session.id, title: session.title, updatedAt: session.updatedAt }].slice(-12);
        });
        return session;
      } catch (e) {
        // Recover the UI from the local browser cache when the server is unavailable.
        try {
          const raw = localStorage.getItem(`codeforge_chat_${id}`);
          if (raw) {
            const cached = JSON.parse(raw);
            let cachedFiles = Array.isArray(cached.files) ? cached.files : [];
            if (!cachedFiles.length) {
              try {
                const separate = JSON.parse(localStorage.getItem(`codeforge_files_${id}`) || "null");
                if (Array.isArray(separate)) cachedFiles = separate;
              } catch {}
            }
            const session = { ...cached, id, files: cachedFiles, localOnly: true };
            setActiveChatId(id);
            setActiveSession(session);
            setOpenSessions((prev) => [...prev.filter((s) => s.id !== id), { id, title: session.title || "Сессия" }].slice(-12));
            notify?.("Открыт локальный кэш чата", "info");
            return session;
          }
        } catch {
          // ignore cache corruption
        }
        notify?.("Не удалось загрузить чат", "error");
        return null;
      } finally {
        loadingRef.current.delete(id);
      }
    })();

    loadingRef.current.set(id, promise);
    return promise;
  }, [notify]);

  useEffect(() => {
    if (!ready || !activeChatId) return;
    if (activeSession?.id === activeChatId) return;
    void loadChat(activeChatId);
  }, [ready, activeChatId, activeSession?.id, loadChat]);

  const ensureNewChat = useCallback(async () => {
    const session = makeNewSession();
    setActiveChatId(session.id);
    setActiveSession(session);
    setOpenSessions((prev) => [...prev.filter((s) => s.id !== session.id), { id: session.id, title: session.title }].slice(-12));
    try {
      localStorage.setItem(`codeforge_chat_${session.id}`, JSON.stringify(session));
    } catch {
      // ignore
    }
    try {
      const res = await fetch(`${API_BASE}/projects/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
      if (res.ok) {
        setActiveSession((prev) => prev ? { ...prev, localOnly: false } : prev);
        await loadChatList();
      }
    } catch {
      // The local-first session remains valid and will sync on first successful message save.
    }
    return session.id;
  }, [loadChatList]);

  const newChat = useCallback(() => ensureNewChat(), [ensureNewChat]);

  const closeSessionTab = useCallback(async (id) => {
    const next = openSessions.filter((s) => s.id !== id);
    if (id !== activeChatId) {
      setOpenSessions(next);
      return;
    }
    const fallback = next[next.length - 1] || chatList.find((c) => c.id !== id);
    if (fallback?.id) {
      await loadChat(fallback.id);
      setOpenSessions(next.length ? next : [{ id: fallback.id, title: fallback.title || "Сессия" }]);
    } else {
      const freshId = await ensureNewChat();
      setOpenSessions([{ id: freshId, title: "Новая сессия" }]);
    }
  }, [openSessions, activeChatId, chatList, loadChat, ensureNewChat]);

  const renameSessionTab = useCallback((id, title) => {
    const safeTitle = String(title || "Сессия").trim().slice(0, 120) || "Сессия";
    setOpenSessions((prev) => prev.map((s) => s.id === id ? { ...s, title: safeTitle } : s));
    setActiveSession((prev) => prev?.id === id ? { ...prev, title: safeTitle } : prev);
  }, []);

  const saveSessionMetadata = useCallback(async (id, patch) => {
    if (!id) return false;
    try {
      const res = await fetch(`${API_BASE}/projects/chats/${encodeURIComponent(id)}/meta`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch {
      return false;
    }
  }, []);

  const takeSnapshot = useCallback(async (label, files = []) => {
    try {
      const res = await fetch(`${API_BASE}/projects/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: activeChatId, label, files })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      notify?.("Снимок версии сохранён", "success");
      return data.id;
    } catch {
      notify?.("Не удалось создать снимок", "error");
      return null;
    }
  }, [activeChatId, notify]);

  const loadSnapshots = useCallback(async () => {
    if (!activeChatId) return [];
    try {
      const res = await fetch(`${API_BASE}/projects/snapshots/${encodeURIComponent(activeChatId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSnapshots(data.snapshots || []);
      return data.snapshots || [];
    } catch {
      setSnapshots([]);
      return [];
    }
  }, [activeChatId]);

  const restoreSnapshot = useCallback((snapshot) => {
    notify?.(`Восстановлена версия: ${snapshot.label || "снимок"}`, "success");
    return snapshot.files || [];
  }, [notify]);

  const diffSnapshots = useCallback(async (fromId, toId) => {
    if (!activeChatId) return null;
    try {
      const params = new URLSearchParams({ from: fromId, to: toId });
      const res = await fetch(`${API_BASE}/projects/git/${encodeURIComponent(activeChatId)}/diff?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch {
      notify?.("Не удалось получить diff между снимками", "error");
      return null;
    }
  }, [activeChatId, notify]);

  const value = useMemo(() => ({
    ready,
    chatId: activeChatId,
    activeChatId,
    activeSession,
    openSessions,
    closeSessionTab,
    renameSessionTab,
    chatList,
    loadChatList,
    loadChat,
    newChat,
    saveSessionMetadata,
    setActiveSession,
    snapshots,
    loadSnapshots,
    takeSnapshot,
    restoreSnapshot,
    diffSnapshots,
  }), [
    ready, activeChatId, activeSession, openSessions, closeSessionTab, renameSessionTab,
    chatList, loadChatList, loadChat, newChat, saveSessionMetadata, snapshots,
    loadSnapshots, takeSnapshot, restoreSnapshot, diffSnapshots,
  ]);

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

export function useSessions() {
  const ctx = React.useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}
