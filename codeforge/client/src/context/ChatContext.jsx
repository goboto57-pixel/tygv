import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "./uuid.js";
import { useFiles } from "./FilesContext.jsx";
import { useSessions } from "./SessionsContext.jsx";

const WORKSPACE_KEY = "codeforge_workspace_id";

function getWorkspaceId() {
  try {
    let id = localStorage.getItem(WORKSPACE_KEY);
    if (!id) {
      id = `ws_${uuid()}`;
      localStorage.setItem(WORKSPACE_KEY, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ChatContext = createContext(null);

function normalizeRestoredMessages(session) {
  const ui = Array.isArray(session?.uiMessages) && session.uiMessages.length ? session.uiMessages : session?.messages;
  if (!Array.isArray(ui)) return [];
  return ui
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      ...m,
      id: m.id || uuid(),
      content: typeof m.content === "string" ? m.content : "",
      images: undefined,
    }));
}

function toPersistedMessages(messages) {
  return messages.map((m) => {
    const copy = { ...m };
    if (Array.isArray(copy.images)) delete copy.images;
    if (Array.isArray(copy.reasoning) && copy.reasoning.length > 12000) copy.reasoning = copy.reasoning.slice(-12000);
    if (typeof copy.reasoning === "string" && copy.reasoning.length > 12000) copy.reasoning = copy.reasoning.slice(-12000);
    return copy;
  });
}

export function ChatProvider({ children, settings, notify, chatId, initialSession, sessionLoaded = false }) {
  const { files, setFiles } = useFiles();
  const { renameSessionTab } = useSessions();
  const [messages, setMessages] = useState(() => normalizeRestoredMessages(initialSession));
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [usage, setUsage] = useState({ prompt_tokens: 0, completion_tokens: 0 });
  const [pendingDiff, setPendingDiff] = useState(null);
  const [budgetWarning, setBudgetWarning] = useState(null);
  const [sessionReport, setSessionReport] = useState(null);
  const [memoryEntries, setMemoryEntries] = useState([]);
  const abortRef = useRef(null);
  const persistTimerRef = useRef(null);
  const lastSavedPayloadRef = useRef("");
  const messagesRef = useRef(messages);
  const filesRef = useRef(files);
  const sessionMetaRef = useRef({ chatId, sessionLoaded });

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { sessionMetaRef.current = { chatId, sessionLoaded }; }, [chatId, sessionLoaded]);

  useEffect(() => {
    setMessages(normalizeRestoredMessages(initialSession));
    setUsage({ prompt_tokens: 0, completion_tokens: 0 });
    setPendingPlan(null);
    setPendingDiff(null);
    setSessionReport(null);
    setBudgetWarning(null);
    setMemoryEntries([]);
  }, [chatId, initialSession]);

  const persistNow = useCallback(async (overrideMessages) => {
    const currentChatId = sessionMetaRef.current.chatId;
    if (!currentChatId || !sessionMetaRef.current.sessionLoaded) return;
    const sourceMessages = Array.isArray(overrideMessages) ? overrideMessages : messagesRef.current;
    const uiMessages = toPersistedMessages(sourceMessages);
    const firstUser = uiMessages.find((m) => m.role === "user" && m.content?.trim());
    const title = firstUser?.content?.trim().replace(/\s+/g, " ").slice(0, 72) || "Новая сессия";
    const payload = JSON.stringify({ chatId: currentChatId, uiMessages, title });
    if (payload === lastSavedPayloadRef.current) return;
    lastSavedPayloadRef.current = payload;
    const cacheRecord = { id: currentChatId, title, uiMessages, files: filesRef.current };
    try { localStorage.setItem(`codeforge_chat_${currentChatId}`, JSON.stringify(cacheRecord)); } catch {}
    try {
      const res = await fetch(`${API_BASE}/projects/chats/${encodeURIComponent(currentChatId)}/messages`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: uiMessages, uiMessages, title }),
        keepalive: true
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      renameSessionTab(currentChatId, title);
    } catch {
      // Keep the local copy and retry once shortly after a transient network
      // failure even if the user does not produce another message.
      setTimeout(() => {
        const liveId = sessionMetaRef.current.chatId;
        if (liveId === currentChatId && sessionMetaRef.current.sessionLoaded) {
          lastSavedPayloadRef.current = "";
          void persistNow(sourceMessages);
        }
      }, 1800);
    }
  }, [renameSessionTab]);

  useEffect(() => {
    if (!chatId || messages.length === 0) return undefined;
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => persistNow(messages), 650);
    return () => clearTimeout(persistTimerRef.current);
  }, [chatId, messages, persistNow, sessionLoaded]);

  useEffect(() => {
    const flushOnHide = () => {
      const { chatId: currentChatId, sessionLoaded: loaded } = sessionMetaRef.current;
      if (!currentChatId || !loaded) return;
      const uiMessages = toPersistedMessages(messagesRef.current);
      const firstUser = uiMessages.find((m) => m.role === "user" && m.content?.trim());
      const title = firstUser?.content?.trim().replace(/\s+/g, " ").slice(0, 72) || "Новая сессия";
      const payload = { messages: uiMessages, uiMessages, title };
      try {
        localStorage.setItem(`codeforge_chat_${currentChatId}`, JSON.stringify({ id: currentChatId, title, uiMessages, files: filesRef.current }));
      } catch {}
      try {
        const body = new Blob([JSON.stringify(payload)], { type: "application/json" });
        navigator.sendBeacon(`${API_BASE}/projects/chats/${encodeURIComponent(currentChatId)}/messages`, body);
      } catch {}
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, []);

  useEffect(() => () => {
    clearTimeout(persistTimerRef.current);
  }, []);

  const sendMessage = useCallback(async (text, images) => {
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!text.trim() && !hasImages) return;
    if (isStreaming) return;

    const userMsg = { id: uuid(), role: "user", content: text, images: hasImages ? images : undefined };
    const nextHistory = [...messages, userMsg];
    messagesRef.current = nextHistory;
    setMessages(nextHistory);
    // Save immediately so a tab/browser crash does not erase the prompt.
    void persistNow(nextHistory);
    setIsStreaming(true);
    setPendingPlan(null);

    const assistantId = uuid();
    messagesRef.current = [...nextHistory, { id: assistantId, role: "assistant", content: "", reasoning: "", toolEvents: [], plan: null }];
    setMessages(messagesRef.current);

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
          model: settings.model,
          mode: settings.mode || "single",
          requireApproval: !!settings.requireApproval,
          autoRollback: settings.autoRollback !== false,
          images: hasImages ? images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })) : undefined,
          memoryKey: getWorkspaceId()
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json())?.error || detail; } catch {}
        throw new Error(detail);
      }
      if (!res.body) throw new Error("Поток ответа недоступен");

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
          const line = part.split("\n").find((x) => x.trim().startsWith("data:"));
          if (!line) continue;
          try { handleStreamEvent(JSON.parse(line.replace(/^data:\s*/, "")), assistantId); } catch {}
        }
      }
      if (buffer.trim()) {
        const line = buffer.split("\n").find((x) => x.trim().startsWith("data:"));
        if (line) {
          try { handleStreamEvent(JSON.parse(line.replace(/^data:\s*/, "")), assistantId); } catch {}
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        notify(`Ошибка соединения с агентом: ${e.message}`, "error");
        setMessages((prev) => { const next = prev.map((m) => m.id === assistantId ? { ...m, content: m.content || "Не удалось завершить запрос. Попробуйте ещё раз." } : m); messagesRef.current = next; return next; });
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
      setTimeout(() => persistNow(messagesRef.current), 0);
    }

    function handleStreamEvent(evt, aId) {
      switch (evt.type) {
        case "reasoning":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, reasoning: (m.reasoning || "") + evt.text } : m));
          break;
        case "tool_call":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, toolEvents: [...(m.toolEvents || []), { name: evt.name, args: evt.args, status: "running" }] } : m));
          break;
        case "tool_result":
          setMessages((prev) => prev.map((m) => {
            if (m.id !== aId) return m;
            const events = [...(m.toolEvents || [])];
            for (let i = events.length - 1; i >= 0; i--) {
              if (events[i].name === evt.name && events[i].status === "running") {
                events[i] = { ...events[i], status: "done", result: evt.result };
                break;
              }
            }
            return { ...m, toolEvents: events };
          }));
          break;
        case "vision":
          notify(`Анализирую ${evt.count} изображение(й) через ${evt.model}`, "info");
          break;
        case "plan":
          setPendingPlan(evt.plan);
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: evt.plan } : m));
          break;
        case "file":
          setFiles((prev) => {
            const map = new Map(prev.map((f) => [f.path, f]));
            map.set(evt.path, { path: evt.path, content: evt.content });
            return Array.from(map.values());
          });
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, files: [...(m.files || []), { path: evt.path, content: evt.content }] } : m));
          break;
        case "files":
          if (Array.isArray(evt.files)) setFiles(evt.files);
          break;
        case "file_deleted":
          setFiles((prev) => prev.filter((f) => f.path !== evt.path));
          break;
        case "test_run":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, testRuns: [...(m.testRuns || []), { command: evt.command, ok: evt.ok, passed: evt.passed, failed: evt.failed, total: evt.total, timedOut: evt.timedOut }] } : m));
          break;
        case "terminal":
          break;
        case "final":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, content: evt.text } : m));
          break;
        case "usage":
          setUsage((prev) => ({ prompt_tokens: prev.prompt_tokens + (evt.usage?.prompt_tokens || 0), completion_tokens: prev.completion_tokens + (evt.usage?.completion_tokens || 0) }));
          break;
        case "error":
          notify(evt.message || "Ошибка агента", "error");
          break;
        case "prompt_enhanced":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, promptEnhancement: { original: evt.original, enhanced: evt.enhanced } } : m));
          break;
        case "council":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, council: { ...(m.council || {}), ...evt } } : m));
          break;
        case "subagent_start":
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, subagents: [...(m.subagents || []), { task: evt.task, status: "running" }] } : m));
          break;
        case "subagent_done":
          setMessages((prev) => prev.map((m) => {
            if (m.id !== aId) return m;
            const list = [...(m.subagents || [])];
            for (let i = list.length - 1; i >= 0; i--) {
              if (list[i].status === "running") { list[i] = { ...list[i], status: "done", report: evt.report }; break; }
            }
            return { ...m, subagents: list };
          }));
          break;
        case "diff_pending":
          setPendingDiff({ token: evt.token, path: evt.path, kind: evt.kind, before: evt.before, after: evt.after });
          break;
        case "diff_approved":
        case "diff_rejected":
          setPendingDiff(null);
          break;
        case "budget_warning":
          setBudgetWarning({ level: evt.level, kind: evt.kind, value: evt.value, limit: evt.limit });
          notify(evt.kind === "tokens" ? `Много токенов (${Number(evt.value || 0).toLocaleString("ru-RU")} из ${Number(evt.limit || 0).toLocaleString("ru-RU")})` : `Задача выполняется долго (${Math.round((evt.value || 0) / 1000)}с)`, evt.level === "hard" ? "error" : "info");
          break;
        case "rollback":
          notify(evt.reason || "Изменения хода откачены", "error");
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, rolledBack: true, rollbackReason: evt.reason } : m));
          break;
        case "session_report":
          setSessionReport({ metrics: evt.metrics, rolledBack: evt.rolledBack, ts: Date.now() });
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, sessionReport: { metrics: evt.metrics, rolledBack: evt.rolledBack } } : m));
          break;
        case "memory_saved":
          setMemoryEntries((prev) => [...prev, evt.entry]);
          setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, memorySaved: [...(m.memorySaved || []), evt.entry] } : m));
          break;
        default:
          break;
      }
    }
  }, [files, chatId, isStreaming, messages, notify, persistNow, setFiles, settings.model, settings.mode, settings.requireApproval, settings.autoRollback]);

  const resolveDiff = useCallback(async (approved) => {
    if (!pendingDiff?.token) return;
    const token = pendingDiff.token;
    setPendingDiff(null);
    try {
      const res = await fetch(`${API_BASE}/chat/approve/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: !!approved }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      notify("Не удалось отправить решение по изменению", "error");
    }
  }, [pendingDiff, notify]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]); setUsage({ prompt_tokens: 0, completion_tokens: 0 }); setPendingPlan(null); setSessionReport(null); setBudgetWarning(null); setMemoryEntries([]);
    void persistNow([]);
  }, [persistNow]);

  const value = useMemo(() => ({ messages, setMessages, isStreaming, pendingPlan, setPendingPlan, usage, pendingDiff, resolveDiff, budgetWarning, sessionReport, memoryEntries, sendMessage, stopStreaming, clearMessages, persistNow }), [messages, isStreaming, pendingPlan, usage, pendingDiff, resolveDiff, budgetWarning, sessionReport, memoryEntries, sendMessage, stopStreaming, clearMessages, persistNow]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
