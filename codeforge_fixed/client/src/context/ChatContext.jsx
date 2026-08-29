import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "./uuid.js";
import { useFiles } from "./FilesContext.jsx";
import { useSessions } from "./SessionsContext.jsx";

const WORKSPACE_KEY = "codeforge_workspace_id";

export function getWorkspaceId() {
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
  const isStreamingRef = useRef(false);
  const persistTimerRef = useRef(null);
  const lastSavedPayloadRef = useRef("");
  const messagesRef = useRef(messages);
  const filesRef = useRef(files);
  const sessionMetaRef = useRef({ chatId, sessionLoaded });

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { sessionMetaRef.current = { chatId, sessionLoaded }; }, [chatId, sessionLoaded]);

  const prevChatIdRef = useRef(chatId);
  const initializedRef = useRef(false);
  useEffect(() => {
    // Only reset when switching chats, not when same chat's title updates
    // This fixes "answer appears then disappears" bug
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      initializedRef.current = true;
      setMessages(normalizeRestoredMessages(initialSession));
      setUsage({ prompt_tokens: 0, completion_tokens: 0 });
      setPendingPlan(null);
      setPendingDiff(null);
      setSessionReport(null);
      setBudgetWarning(null);
      setMemoryEntries([]);
    } else if (!initializedRef.current && initialSession) {
      // First load for this chat (initialSession was null then loaded)
      const normalized = normalizeRestoredMessages(initialSession);
      if (normalized.length > 0 && messagesRef.current.length === 0) {
        setMessages(normalized);
        initializedRef.current = true;
      }
    }
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
        fetch(`${API_BASE}/projects/chats/${encodeURIComponent(currentChatId)}/messages`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnHide(); });
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushOnHide);
    };
  }, []);

  useEffect(() => () => {
    clearTimeout(persistTimerRef.current);
  }, []);

  const currentRunIdRef = useRef(null);
  const currentAssistantIdRef = useRef(null);

  const clearActiveRun = useCallback(() => {
    const rid = currentRunIdRef.current;
    const cid = sessionMetaRef.current.chatId;
    currentRunIdRef.current = null;
    currentAssistantIdRef.current = null;
    try { if (rid && cid) sessionStorage.removeItem(`codeforge_active_run_${cid}`); } catch {}
  }, []);

  // Pure reducer that folds a streamed server event into the assistant message
  // identified by `aId`. Shared by both fresh sends and resume replays so the
  // reconstructed message is byte-identical.
  //
  // Wrapped in try/catch: different models (e.g. Devstral vs Mistral Medium)
  // can shape tool output slightly differently (a plan's `steps` missing,
  // non-object step entries, etc). Without this guard, one malformed event
  // throws inside a setState updater and React unmounts the entire app to
  // the AppErrorBoundary screen — killing an otherwise-fine session over a
  // single cosmetic field. Log and skip the event instead; the rest of the
  // stream (and the job itself, which is server-side and unaffected) keeps
  // going.
  const handleStreamEvent = useCallback((evt, aId) => {
   try {
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
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: { ...evt.plan, token: evt.token, completedSteps: 0 } } : m));
        break;
      case "plan_proposed":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: { ...evt.plan, token: evt.token, completedSteps: m.plan?.completedSteps || 0 } } : m));
        break;
      case "plan_approved":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: { ...(m.plan || {}), token: null, approved: true, approvedNote: evt.note } } : m));
        notify("План утверждён — агент приступает к работе", "success");
        break;
      case "plan_rejected":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: { ...(m.plan || {}), token: null, rejected: true, rejectedNote: evt.note } } : m));
        notify(evt.note ? `План отклонён: ${evt.note}` : "План отклонён", "info");
        break;
      case "plan_step":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, plan: { ...(m.plan || {}), completedSteps: evt.completed } } : m));
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
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, content: evt.text, status: "done" } : m));
        break;
      case "done":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, status: "done" } : m));
        // Job finished server-side — nothing left to resume.
        clearActiveRun();
        break;
      case "status":
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, status: evt.status || evt.text, statusText: evt.text } : m));
        break;
      case "usage":
        setUsage((prev) => ({ prompt_tokens: prev.prompt_tokens + (evt.usage?.prompt_tokens || 0), completion_tokens: prev.completion_tokens + (evt.usage?.completion_tokens || 0) }));
        break;
      case "rate_limit":
        notify(evt.message || `Пауза ${Math.round((evt.delay || 2000)/1000)}с из-за лимита — продолжаю…`, "info");
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, status: "rate_limited", statusText: `Лимит — пауза ${Math.round((evt.delay || 2000)/1000)}с…` } : m));
        break;
      case "error":
        notify(evt.message || "Ошибка агента", "error");
        // Persist the FULL diagnostic detail (HTTP status, request/response
        // headers+bodies from the server, stack) onto the message, and keep
        // a copy in sessionStorage too — a toast disappears in a few
        // seconds, this stays in the chat and is copyable.
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, errorMessage: evt.message, errorDetail: evt.detail || null, errorStack: evt.stack || null } : m));
        try {
          const key = "codeforge_error_log";
          const prev = JSON.parse(sessionStorage.getItem(key) || "[]");
          prev.push({ kind: "agent_error", message: evt.message, detail: evt.detail || null, stack: evt.stack || null, at: new Date().toISOString() });
          sessionStorage.setItem(key, JSON.stringify(prev.slice(-20)));
        } catch {}
        if (evt.message && !/aborted/i.test(evt.message)) clearActiveRun();
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
      case "perf":
        // Where the turn's wall-clock time actually went — see PerfPanel.jsx.
        setMessages((prev) => prev.map((m) => m.id === aId ? {
          ...m,
          perf: {
            totalMs: evt.totalMs,
            modelMs: evt.modelMs,
            modelCalls: evt.modelCalls,
            rateLimitWaitMs: evt.rateLimitWaitMs,
            rateLimitHits: evt.rateLimitHits,
            toolMs: evt.toolMs,
            toolCalls: evt.toolCalls,
            otherMs: evt.otherMs
          }
        } : m));
        break;
      case "memory_saved":
        setMemoryEntries((prev) => [...prev, evt.entry]);
        setMessages((prev) => prev.map((m) => m.id === aId ? { ...m, memorySaved: [...(m.memorySaved || []), evt.entry] } : m));
        break;
      default:
        break;
    }
   } catch (err) {
      try {
        const key = "codeforge_error_log";
        const prev = JSON.parse(sessionStorage.getItem(key) || "[]");
        prev.push({ kind: "stream_event_handler", eventType: evt?.type, message: err?.message, stack: err?.stack, at: new Date().toISOString() });
        sessionStorage.setItem(key, JSON.stringify(prev.slice(-20)));
      } catch {}
      console.error("[CodeForge] failed to apply stream event, skipping:", evt?.type, err);
      notify(`Не удалось обработать событие агента (${evt?.type || "?"}) — пропущено`, "error");
   }
  }, [notify, setFiles, clearActiveRun]);

  // Opens the SSE stream for a given run and routes events into handleStreamEvent.
  // The server job is fully detached: closing this connection does NOT stop the
  // agent, it just stops delivering events to THIS client.
  const openStream = useCallback(async ({ runId, assistantId, body, isResume }) => {
    const controller = new AbortController();
    abortRef.current = controller;
    isStreamingRef.current = true;
    setIsStreaming(true);
    let receivedTerminal = false;
    try {
      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
          let evt;
          try { evt = JSON.parse(line.replace(/^data:\s*/, "")); } catch { continue; }
          if (evt.type === "done" || evt.type === "error" || evt.type === "job_not_found") receivedTerminal = true;
          if (evt.type === "resume_start") {
            // A reconnecting client rebuilds the assistant message from scratch
            // using the replayed buffered events that follow.
            setMessages((prev) => prev.map((m) => m.id === assistantId
              ? { id: assistantId, role: "assistant", content: "", reasoning: "", toolEvents: [], plan: null, status: "thinking", files: [], testRuns: [], subagents: [], council: null, memorySaved: [], sessionReport: null, promptEnhancement: null, rolledBack: false }
              : m));
            continue;
          }
          if (evt.type === "run_started") continue;
          if (evt.type === "job_not_found") {
            if (isResume) {
              // Server lost the job (e.g. restart). Restart the turn fresh if we
              // still have the history locally.
              const hist = messagesRef.current
                .filter((m) => (m.role === "user" || m.role === "assistant") && !(m.role === "assistant" && !m.content))
                .map((m) => ({ role: m.role, content: m.content }));
              const newRunId = uuid();
              currentRunIdRef.current = newRunId;
              await openStream({
                runId: newRunId,
                assistantId,
                isResume: false,
                body: {
                  history: hist,
                  files: filesRef.current,
                  chatId: sessionMetaRef.current.chatId,
                  model: settings.model,
                  mode: settings.mode || "single",
                  requireApproval: !!settings.requireApproval,
                  autoRollback: settings.autoRollback !== false,
                  memoryKey: getWorkspaceId(),
                  runId: newRunId
                }
              });
            }
            return;
          }
          handleStreamEvent(evt, assistantId);
        }
      }
      if (!receivedTerminal) {
        // The connection ended (proxy idle timeout, network blip, etc) but the
        // server never told us the job finished. The job is detached and may
        // well still be running — silently treating this as "turn over" is
        // exactly what lets a second job get started on top of it (see
        // jobManager.js). Log it clearly and try to reattach instead.
        try {
          const key = "codeforge_error_log";
          const prev = JSON.parse(sessionStorage.getItem(key) || "[]");
          prev.push({ kind: "stream_dropped_no_terminal", runId: body?.runId, chatId: body?.chatId, at: new Date().toISOString() });
          sessionStorage.setItem(key, JSON.stringify(prev.slice(-20)));
        } catch {}
        console.warn("[CodeForge] SSE ended without a terminal event — reattaching to check if the job is still running", body?.runId);
        notify("Соединение с агентом прервалось — переподключаюсь…", "info");
        isStreamingRef.current = false;
        setIsStreaming(false);
        abortRef.current = null;
        await resumeRun(body?.runId);
        return;
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        notify(`Ошибка соединения с агентом: ${e.message}`, "error");
        setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content: m.content || "Не удалось завершить запрос. Попробуйте ещё раз." } : m));
      }
    } finally {
      abortRef.current = null;
      isStreamingRef.current = false;
      setIsStreaming(false);
      setTimeout(() => persistNow(messagesRef.current), 0);
    }
  }, [handleStreamEvent, notify, persistNow, settings.model, settings.mode, settings.requireApproval, settings.autoRollback]);

  // Re-attaches to a still-running (or just-finished) server job by its runId.
  // Used when the user navigates away and back, or reloads the page while the
  // agent is still working on the server.
  const resumeRun = useCallback(async (runId) => {
    if (isStreamingRef.current || !runId) return;
    const assistantId = uuid();
    currentAssistantIdRef.current = assistantId;
    setPendingPlan(null);
    setBudgetWarning(null);
    setSessionReport(null);
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", reasoning: "", toolEvents: [], plan: null, status: "thinking" }]);
    await openStream({ runId, assistantId, isResume: true, body: { runId, chatId, memoryKey: getWorkspaceId(), resume: true } });
  }, [openStream, chatId]);

  const sendMessage = useCallback(async (text, images) => {
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!text.trim() && !hasImages) return;
    if (isStreamingRef.current) return;

    // Use refs to avoid stale closure - critical for display bug
    const currentMessages = messagesRef.current;
    const currentFiles = filesRef.current;

    const userMsg = { id: uuid(), role: "user", content: text, images: hasImages ? images : undefined };
    const nextHistory = [...currentMessages, userMsg];
    messagesRef.current = nextHistory;
    setMessages(nextHistory);
    pushRecentPrompt(text);
    // Save immediately so a tab/browser crash does not erase the prompt.
    void persistNow(nextHistory);
    setPendingPlan(null);
    setBudgetWarning(null);
    setSessionReport(null);

    const assistantId = uuid();
    currentAssistantIdRef.current = assistantId;
    messagesRef.current = [...nextHistory, { id: assistantId, role: "assistant", content: "", reasoning: "", toolEvents: [], plan: null, status: "thinking" }];
    setMessages(messagesRef.current);

    const runId = uuid();
    currentRunIdRef.current = runId;
    try { sessionStorage.setItem(`codeforge_active_run_${chatId}`, JSON.stringify({ runId, chatId })); } catch {}

    await openStream({
      runId,
      assistantId,
      isResume: false,
      body: {
        // Never forward an assistant turn with empty content: Mistral hard-rejects
        // {role:"assistant", content:""} (no tool_calls) with a 400 on the *whole*
        // request. A prior turn can end up empty if it was aborted, errored, or hit
        // the loop limit before producing any summary text — drop those here so one
        // broken turn doesn't brick every future message in this chat.
        history: nextHistory
          .filter((m) => !(m.role === "assistant" && !m.content))
          .map((m) => ({ role: m.role, content: m.content })),
        files: currentFiles,
        chatId,
        model: settings.model,
        mode: settings.mode || "single",
        toolMode: settings.toolMode || "code",
        reasoningEffort: settings.reasoningEffort || "none",
        requireApproval: !!settings.requireApproval,
        autoRollback: settings.autoRollback !== false,
        images: hasImages ? images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })) : undefined,
        memoryKey: getWorkspaceId(),
        runId,
        requirePlanApproval: !!settings.planApproval,
        circuitBreaker: settings.circuitBreaker !== false,
        budgetPause: settings.budgetPause === true
      }
    });
  }, [openStream, chatId, notify, persistNow, settings.model, settings.mode, settings.toolMode, settings.reasoningEffort, settings.requireApproval, settings.autoRollback]);

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

  // Approves (or rejects with an optional text note) a proposed plan. Uses the
  // same token-resolving approval route as diff review — the detached server
  // job is paused on make_plan and resumes once this resolves.
  const resolvePlanApproval = useCallback(async (token, approved, note) => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/chat/approve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: !!approved, note: note || "" })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      notify("Не удалось отправить решение по плану", "error");
    }
  }, [notify]);

  // Re-runs the user's last message as a fresh turn (retry after a failure or
  // to iterate on the result). No-ops if a stream is in flight.
  const retryLastTurn = useCallback(() => {
    if (isStreamingRef.current) return;
    const msgs = messagesRef.current;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        const text = msgs[i].content || "";
        const images = msgs[i].images;
        void sendMessage(text, images);
        return;
      }
    }
    notify("Нет сообщения для повтора", "info");
  }, [sendMessage, notify]);

  // Exports the current conversation as Markdown (with a JSON fallback body)
  // and triggers a download. Useful for sharing or archival.
  const exportChat = useCallback(() => {
    const msgs = messagesRef.current;
    if (!msgs.length) { notify("Чат пуст", "info"); return; }
    const md = msgs.map((m) => {
      const head = m.role === "user" ? "## 👤 Пользователь" : "## 🤖 CodeForge";
      const body = (m.content || "").trim();
      const reasoning = m.reasoning ? `\n\n<details><summary>Рассуждения</summary>\n\n${m.reasoning}\n\n</details>` : "";
      return `${head}\n\n${body}${reasoning}`;
    }).join("\n\n---\n\n");
    const blob = new Blob([`# Экспорт чата CodeForge\n\n${md}`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `codeforge-chat-${Date.now()}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [notify]);



  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    const rid = currentRunIdRef.current;
    if (rid) {
      // Tell the server to cancel the detached job so it stops burning tokens.
      fetch(`${API_BASE}/chat/abort/${rid}`, { method: "POST" }).catch(() => {});
    }
    clearActiveRun();
    isStreamingRef.current = false;
    setIsStreaming(false);
  }, [clearActiveRun]);

  const clearMessages = useCallback(() => {
    setMessages([]); setUsage({ prompt_tokens: 0, completion_tokens: 0 }); setPendingPlan(null); setSessionReport(null); setBudgetWarning(null); setMemoryEntries([]);
    void persistNow([]);
  }, [persistNow]);

  const deleteMessage = useCallback((id) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    void persistNow(messagesRef.current.filter((m) => m.id !== id));
  }, [persistNow]);

  const togglePin = useCallback((id) => {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, pinned: !m.pinned } : m));
    void persistNow(messagesRef.current.map((m) => m.id === id ? { ...m, pinned: !m.pinned } : m));
  }, [persistNow]);

  const toggleBookmark = useCallback((id) => {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, bookmarked: !m.bookmarked } : m));
    void persistNow(messagesRef.current.map((m) => m.id === id ? { ...m, bookmarked: !m.bookmarked } : m));
  }, [persistNow]);

  const importChat = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const msgs = Array.isArray(data.uiMessages) ? data.uiMessages : Array.isArray(data.messages) ? data.messages : [];
        if (!msgs.length) { notify("Файл не содержит сообщений", "error"); return; }
        setMessages(msgs.map((m) => ({ ...m, id: m.id || uuid() })));
        if (Array.isArray(data.files)) setFiles(data.files);
        void persistNow(msgs);
        notify(`Импортировано ${msgs.length} сообщений`, "success");
      } catch (e) { notify(`Ошибка импорта: ${e.message}`, "error"); }
    };
    reader.readAsText(file);
  }, [notify, persistNow, setFiles]);

  const exportPdf = useCallback(() => {
    const msgs = messagesRef.current;
    if (!msgs.length) { notify("Чат пуст", "info"); return; }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CodeForge Chat</title><style>body{font-family:sans-serif;padding:24px;max-width:760px;margin:auto}h2{color:#333}.u{color:#2563eb}.a{color:#111}.m{margin:14px 0;padding:10px 14px;border-radius:8px;background:#f6f8fa}pre{background:#111;color:#eee;padding:10px;border-radius:6px;overflow:auto}</style></head><body><h1>Экспорт чата CodeForge</h1>${msgs.map((m) => `<div class="m ${m.role === "user" ? "u" : "a"}"><h2>${m.role === "user" ? "Пользователь" : "CodeForge"}</h2>${(m.content || "").replace(/</g, "&lt;")}</div>`).join("")}</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    setTimeout(() => { try { w?.focus(); w?.print(); } catch {} }, 400);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, [notify]);

  const mergeFork = useCallback((otherMessages) => {
    if (!Array.isArray(otherMessages) || !otherMessages.length) return;
    setMessages((prev) => [...prev, ...otherMessages.map((m) => ({ ...m, id: m.id || uuid() }))]);
    notify("Ветка слита в текущий чат", "success");
  }, [notify]);

  const pushRecentPrompt = useCallback((text) => {
    if (!text?.trim()) return;
    try {
      const key = "codeforge_recent_prompts";
      const arr = JSON.parse(localStorage.getItem(key) || "[]").filter((p) => p !== text);
      arr.unshift(text);
      localStorage.setItem(key, JSON.stringify(arr.slice(0, 20)));
    } catch {}
  }, []);
  const getRecentPrompts = useCallback(() => {
    try { return JSON.parse(localStorage.getItem("codeforge_recent_prompts") || "[]"); } catch { return []; }
  }, []);

  // Auto-resume an in-flight server job when (re)opening a chat: if we closed
  // the tab or navigated away mid-run, the agent kept working server-side and
  // we just need to re-attach to its event stream. The job is fully detached,
  // so the chat is still saved even if nobody is connected.
  useEffect(() => {
    if (!sessionLoaded || !chatId) return;
    if (isStreamingRef.current) return;
    let raw = null;
    try { raw = sessionStorage.getItem(`codeforge_active_run_${chatId}`); } catch {}
    if (!raw) return;
    let runId = null;
    try { runId = JSON.parse(raw)?.runId; } catch {}
    if (runId) void resumeRun(runId);
  }, [chatId, sessionLoaded, resumeRun]);

  const value = useMemo(() => ({ messages, setMessages, isStreaming, pendingPlan, setPendingPlan, usage, pendingDiff, resolveDiff, resolvePlanApproval, budgetWarning, sessionReport, memoryEntries, sendMessage, stopStreaming, retryLastTurn, exportChat, exportPdf, clearMessages, persistNow, deleteMessage, togglePin, toggleBookmark, importChat, mergeFork, pushRecentPrompt, getRecentPrompts }), [messages, isStreaming, pendingPlan, usage, pendingDiff, resolveDiff, resolvePlanApproval, budgetWarning, sessionReport, memoryEntries, sendMessage, stopStreaming, retryLastTurn, exportChat, exportPdf, clearMessages, persistNow, deleteMessage, togglePin, toggleBookmark, importChat, mergeFork, pushRecentPrompt, getRecentPrompts]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
