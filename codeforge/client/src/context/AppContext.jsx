import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { v4 as uuid } from "./uuid.js";

const AppContext = createContext(null);

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export function AppProvider({ children }) {
  const [chatId, setChatId] = useState(() => uuid());
  const [messages, setMessages] = useState([]); // {role, content, id}
  const [files, setFiles] = useState([]); // {path, content}
  const [activeFile, setActiveFile] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [usage, setUsage] = useState({ prompt_tokens: 0, completion_tokens: 0 });
  const [chatList, setChatList] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [toast, setToast] = useState(null);
  const abortRef = useRef(null);

  const notify = useCallback((text, kind = "info") => {
    setToast({ text, kind, id: Date.now() });
  }, []);

  const newChat = useCallback(() => {
    setChatId(uuid());
    setMessages([]);
    setFiles([]);
    setActiveFile(null);
    setPendingPlan(null);
    setUsage({ prompt_tokens: 0, completion_tokens: 0 });
  }, []);

  const loadChatList = useCallback(async () => {
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
      setChatId(id);
      setMessages(data.messages?.filter((m) => m.role !== "system") || []);
      setFiles(data.files || []);
      setActiveFile(data.files?.[0]?.path || null);
    } catch (e) {
      notify("Не удалось загрузить чат", "error");
    }
  }, [notify]);

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
    setFiles(snapshot.files || []);
    notify(`Восстановлена версия: ${snapshot.label || "снимок"}`, "success");
  }, [notify]);

  const uploadFiles = useCallback(async (fileList) => {
    const formData = new FormData();
    Array.from(fileList).forEach((f) => formData.append("files", f));
    try {
      const res = await fetch(`${API_BASE}/files/upload`, { method: "POST", body: formData });
      const data = await res.json();
      const newFiles = (data.files || []).filter((f) => f.isText);
      setFiles((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]));
        newFiles.forEach((f) => map.set(f.path, { path: f.path, content: f.content }));
        return Array.from(map.values());
      });
      if (newFiles.length) setActiveFile(newFiles[0].path);
      notify(`Загружено файлов: ${data.files?.length || 0}`, "success");
    } catch (e) {
      notify("Ошибка загрузки файлов", "error");
    }
  }, [notify]);

  const sendMessage = useCallback(
    async (text) => {
      if (!text.trim() || isStreaming) return;

      const userMsg = { id: uuid(), role: "user", content: text };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setIsStreaming(true);
      setPendingPlan(null);

      const assistantId = uuid();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", reasoning: "", toolEvents: [], plan: null }
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${API_BASE}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            history: nextHistory.map((m) => ({ role: m.role, content: m.content })),
            files,
            chatId
          }),
          signal: controller.signal
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.replace(/^data:\s*/, "");
            let evt;
            try {
              evt = JSON.parse(jsonStr);
            } catch {
              continue;
            }
            handleStreamEvent(evt, assistantId);
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          notify("Ошибка соединения с агентом", "error");
        }
      } finally {
        setIsStreaming(false);
      }

      function handleStreamEvent(evt, aId) {
        switch (evt.type) {
          case "reasoning":
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, reasoning: (m.reasoning || "") + evt.text } : m))
            );
            break;
          case "tool_call":
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aId
                  ? { ...m, toolEvents: [...(m.toolEvents || []), { name: evt.name, args: evt.args, status: "running" }] }
                  : m
              )
            );
            break;
          case "tool_result":
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== aId) return m;
                const events = [...(m.toolEvents || [])];
                for (let i = events.length - 1; i >= 0; i--) {
                  if (events[i].name === evt.name && events[i].status === "running") {
                    events[i] = { ...events[i], status: "done", result: evt.result };
                    break;
                  }
                }
                return { ...m, toolEvents: events };
              })
            );
            break;
          case "plan":
            setPendingPlan(evt.plan);
            setMessages((prev) => (prev.map((m) => (m.id === aId ? { ...m, plan: evt.plan } : m))));
            break;
          case "file":
            setFiles((prev) => {
              const idx = prev.findIndex((f) => f.path === evt.path);
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { path: evt.path, content: evt.content };
                return copy;
              }
              return [...prev, { path: evt.path, content: evt.content }];
            });
            setActiveFile(evt.path);
            break;
          case "file_deleted":
            setFiles((prev) => prev.filter((f) => f.path !== evt.path));
            break;
          case "final":
            setMessages((prev) => (prev.map((m) => (m.id === aId ? { ...m, content: evt.text } : m))));
            break;
          case "usage":
            setUsage((prev) => ({
              prompt_tokens: prev.prompt_tokens + (evt.usage?.prompt_tokens || 0),
              completion_tokens: prev.completion_tokens + (evt.usage?.completion_tokens || 0)
            }));
            break;
          case "error":
            notify(evt.message || "Ошибка агента", "error");
            break;
          default:
            break;
        }
      }
    },
    [messages, files, chatId, isStreaming, notify]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const value = {
    chatId,
    messages,
    files,
    activeFile,
    setActiveFile,
    isStreaming,
    pendingPlan,
    setPendingPlan,
    usage,
    chatList,
    snapshots,
    toast,
    setToast,
    notify,
    newChat,
    loadChatList,
    loadChat,
    takeSnapshot,
    loadSnapshots,
    restoreSnapshot,
    uploadFiles,
    sendMessage,
    stopStreaming
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
