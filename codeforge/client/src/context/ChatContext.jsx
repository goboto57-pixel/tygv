import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import { v4 as uuid } from "./uuid.js";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const ChatContext = createContext(null);

export function ChatProvider({ children, settings, notify, chatId, files }) {
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [usage, setUsage] = useState({ prompt_tokens: 0, completion_tokens: 0 });
  const [pendingDiff, setPendingDiff] = useState(null);
  const [budgetWarning, setBudgetWarning] = useState(null);
  const [sessionReport, setSessionReport] = useState(null);
  const [memoryEntries, setMemoryEntries] = useState([]);
  const abortRef = useRef(null);

  const sendMessage = useCallback(
    async (text, images) => {
      const hasImages = Array.isArray(images) && images.length > 0;
      if (!text.trim() && !hasImages) return;
      if (isStreaming) return;

      const userMsg = { id: uuid(), role: "user", content: text, images: hasImages ? images : undefined };
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
            chatId,
            model: settings.model,
            mode: settings.mode || "single",
            requireApproval: !!settings.requireApproval,
            autoRollback: settings.autoRollback !== false,
            images: hasImages ? images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })) : undefined
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
          case "vision":
            notify(`Анализирую ${evt.count} изображение(й) через ${evt.model}`, "info");
            break;
          case "plan":
            setPendingPlan(evt.plan);
            setMessages((prev) => (prev.map((m) => (m.id === aId ? { ...m, plan: evt.plan } : m))));
            break;
          case "file":
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, files: [...(m.files || []), { path: evt.path, content: evt.content }] } : m))
            );
            break;
          case "file_deleted":
            break;
          case "test_run":
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aId
                  ? {
                      ...m,
                      testRuns: [
                        ...(m.testRuns || []),
                        {
                          command: evt.command,
                          ok: evt.ok,
                          passed: evt.passed,
                          failed: evt.failed,
                          total: evt.total,
                          timedOut: evt.timedOut
                        }
                      ]
                    }
                  : m
              )
            );
            break;
          case "terminal":
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
          case "prompt_enhanced":
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, promptEnhancement: { original: evt.original, enhanced: evt.enhanced } } : m))
            );
            break;
          case "council":
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, council: { ...(m.council || {}), ...evt } } : m))
            );
            break;
          case "subagent_start":
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aId
                  ? { ...m, subagents: [...(m.subagents || []), { task: evt.task, status: "running" }] }
                  : m
              )
            );
            break;
          case "subagent_done":
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== aId) return m;
                const list = [...(m.subagents || [])];
                for (let i = list.length - 1; i >= 0; i--) {
                  if (list[i].status === "running") {
                    list[i] = { ...list[i], status: "done", report: evt.report };
                    break;
                  }
                }
                return { ...m, subagents: list };
              })
            );
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
            notify(
              evt.kind === "tokens"
                ? `Задача расходует много токенов (${evt.value.toLocaleString("ru")} из ${evt.limit.toLocaleString("ru")})`
                : `Задача выполняется долго (${Math.round(evt.value / 1000)}с)`,
              evt.level === "hard" ? "error" : "info"
            );
            break;
          case "rollback":
            notify(evt.reason || "Изменения этого хода откачены из-за проваленных тестов", "error");
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, rolledBack: true, rollbackReason: evt.reason } : m))
            );
            break;
          case "session_report":
            setSessionReport({ metrics: evt.metrics, rolledBack: evt.rolledBack, ts: Date.now() });
            setMessages((prev) =>
              prev.map((m) => (m.id === aId ? { ...m, sessionReport: { metrics: evt.metrics, rolledBack: evt.rolledBack } } : m))
            );
            break;
          case "memory_saved":
            setMemoryEntries((prev) => [...prev, evt.entry]);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === aId ? { ...m, memorySaved: [...(m.memorySaved || []), evt.entry] } : m
              )
            );
            break;
          default:
            break;
        }
      }
    },
    [messages, files, chatId, isStreaming, notify, settings.model, settings.mode, settings.requireApproval]
  );

  const resolveDiff = useCallback(
    async (approved) => {
      if (!pendingDiff?.token) return;
      const token = pendingDiff.token;
      setPendingDiff(null);
      try {
        await fetch(`${API_BASE}/chat/approve/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: !!approved })
        });
      } catch (e) {
        notify("Не удалось отправить решение по изменению", "error");
      }
    },
    [pendingDiff, notify]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setUsage({ prompt_tokens: 0, completion_tokens: 0 });
    setPendingPlan(null);
    setSessionReport(null);
    setBudgetWarning(null);
    setMemoryEntries([]);
  }, []);

  const value = useMemo(() => ({
    messages,
    setMessages,
    isStreaming,
    pendingPlan,
    setPendingPlan,
    usage,
    pendingDiff,
    resolveDiff,
    budgetWarning,
    sessionReport,
    memoryEntries,
    sendMessage,
    stopStreaming,
    clearMessages,
  }), [
    messages,
    isStreaming,
    pendingPlan,
    usage,
    pendingDiff,
    budgetWarning,
    sessionReport,
    memoryEntries,
    sendMessage,
    stopStreaming,
    clearMessages,
  ]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}