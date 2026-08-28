import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { v4 as uuid } from "./uuid.js";

const AppContext = createContext(null);

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export const MODELS = [
  { id: "codestral-latest", label: "Codestral", provider: "Mistral", desc: "код и агентные задачи" },
  { id: "devstral-medium-latest", label: "Devstral Medium", provider: "Mistral", desc: "агентная разработка, сильный tool use" },
  { id: "mistral-large-latest", label: "Mistral Large", provider: "Mistral", desc: "сложные рассуждения" },
  { id: "mistral-medium-latest", label: "Mistral Medium", provider: "Mistral", desc: "баланс скорости и качества" },
  { id: "mistral-small-latest", label: "Mistral Small", provider: "Mistral", desc: "быстрые и простые задачи" }
];

function loadSettings() {
  try {
    const raw = localStorage.getItem("cf_settings");
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch (e) {
    /* ignore */
  }
  return defaultSettings();
}
function defaultSettings() {
  return { theme: "dark", fontSize: "md", model: MODELS[0].id, sendOnEnter: true };
}

export function AppProvider({ children }) {
  const [settings, setSettingsState] = useState(loadSettings);
  const [chatId, setChatId] = useState(() => uuid());
  const [messages, setMessages] = useState([]); // {role, content, id}
  const [files, setFiles] = useState([]); // {path, content}
  const [activeFile, setActiveFile] = useState(null);
  const [openFiles, setOpenFiles] = useState([]); // tabs of open file paths
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [usage, setUsage] = useState({ prompt_tokens: 0, completion_tokens: 0 });
  const [chatList, setChatList] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [toast, setToast] = useState(null);
  const [terminalLog, setTerminalLog] = useState([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [openSessions, setOpenSessions] = useState(() => [
    { id: chatIdInit(), title: "Новая сессия" }
  ]);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortRef = useRef(null);
  const loadChatRef = useRef(null);

  function chatIdInit() {
    return chatId;
  }

  const updateSettings = useCallback((patch) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem("cf_settings", JSON.stringify(next));
      } catch (e) {
        /* ignore */
      }
      return next;
    });
  }, []);

  const notify = useCallback((text, kind = "info") => {
    setToast({ text, kind, id: Date.now() });
  }, []);

  const newChat = useCallback(() => {
    const id = uuid();
    setChatId(id);
    setMessages([]);
    setFiles([]);
    setActiveFile(null);
    setOpenFiles([]);
    setPendingPlan(null);
    setUsage({ prompt_tokens: 0, completion_tokens: 0 });
    setOpenSessions((prev) => [...prev, { id, title: "Новая сессия" }]);
    return id;
  }, []);

  const closeSessionTab = useCallback(
    (id) => {
      setOpenSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          const freshId = uuid();
          if (id === chatId) {
            setChatId(freshId);
            setMessages([]);
            setFiles([]);
            setActiveFile(null);
            setOpenFiles([]);
          }
          return [{ id: freshId, title: "Новая сессия" }];
        }
        if (id === chatId) {
          const fallback = next[next.length - 1];
          loadChatRef.current?.(fallback.id);
        }
        return next;
      });
    },
    [chatId]
  );

  const renameSessionTab = useCallback((id, title) => {
    setOpenSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
  }, []);

  const openFileTab = useCallback((path) => {
    setActiveFile(path);
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const closeFileTab = useCallback(
    (path) => {
      setOpenFiles((prev) => {
        const next = prev.filter((p) => p !== path);
        if (activeFile === path) {
          setActiveFile(next[next.length - 1] || null);
        }
        return next;
      });
    },
    [activeFile]
  );

  const updateFileContent = useCallback((path, content) => {
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content } : f)));
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
      setOpenFiles(data.files?.[0]?.path ? [data.files[0].path] : []);
      setOpenSessions((prev) => {
        if (prev.some((s) => s.id === id)) return prev;
        return [...prev, { id, title: data.title || "Сессия" }];
      });
    } catch (e) {
      notify("Не удалось загрузить чат", "error");
    }
  }, [notify]);
  loadChatRef.current = loadChat;

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

      if (messages.length === 0) {
        const title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
        renameSessionTab(chatId, title);
      }

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
            chatId,
            model: settings.model
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
              const prevContent = idx >= 0 ? prev[idx].content : "";
              if (idx >= 0) {
                const copy = [...prev];
                copy[idx] = { path: evt.path, content: evt.content, prevContent };
                return copy;
              }
              return [...prev, { path: evt.path, content: evt.content, prevContent: "" }];
            });
            openFileTab(evt.path);
            break;
          case "file_deleted":
            setFiles((prev) => prev.filter((f) => f.path !== evt.path));
            break;
          case "terminal":
            setTerminalLog((prev) => [
              ...prev,
              { id: uuid(), command: evt.command, output: evt.output, ts: Date.now() }
            ]);
            setTerminalOpen(true);
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
    [messages, files, chatId, isStreaming, notify, settings.model, renameSessionTab, openFileTab]
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
    openFiles,
    openFileTab,
    closeFileTab,
    updateFileContent,
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
    stopStreaming,
    openSessions,
    closeSessionTab,
    renameSessionTab,
    settings,
    updateSettings,
    MODELS,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    terminalLog,
    terminalOpen,
    setTerminalOpen,
    clearTerminal: () => setTerminalLog([])
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
