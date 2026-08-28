import React, { useRef, useEffect, useCallback } from "react";
import { useChat } from "../context/ChatContext.jsx";
import MessageBubble from "./MessageBubble.jsx";
import ChatInput from "./ChatInput.jsx";
import EmptyState from "./EmptyState.jsx";
import { RotateCcw, Download, CheckCircle2 } from "lucide-react";

const TOOL_LABELS = {
  write_file: "создание файла",
  edit_file: "изменение файла",
  delete_file: "удаление файла",
  read_file: "чтение файла",
  list_files: "список файлов",
  search_code: "поиск по коду",
  find_files: "поиск файлов",
  run_command: "выполнение команды",
  run_tests: "прогон тестов",
  lint_file: "проверка кода",
  make_plan: "план",
  semantic_search: "семантический поиск",
  save_memory: "сохранение в память",
  delegate_to_subagent: "делегирование субагенту"
};

export default function ChatPanel() {
  const { messages, isStreaming, retryLastTurn, exportChat, usage } = useChat();
  const scrollRef = useRef(null);
  const messagesEndRef = useRef(null);
  const rafRef = useRef(null);
  const lastMessage = messages[messages.length - 1];

  const phase = (() => {
    if (!isStreaming || !lastMessage || lastMessage.role !== "assistant") return null;
    if (lastMessage.plan?.token && !lastMessage.plan?.approved && !lastMessage.plan?.rejected) {
      return { label: "Ожидает утверждения плана", icon: "plan" };
    }
    const runningTool = lastMessage.toolEvents?.find((t) => t.status === "running");
    if (runningTool) return { label: `Выполняет: ${TOOL_LABELS[runningTool.name] || runningTool.name}`, icon: "tool" };
    if (lastMessage.reasoning) return { label: "Анализирует задачу", icon: "think" };
    return { label: "Думает…", icon: "think" };
  })();

  const planProgress = (() => {
    const p = lastMessage?.plan;
    if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return null;
    const done = Math.max(0, Math.min(p.steps.length, p.completedSteps || 0));
    return { done, total: p.steps.length };
  })();

  const scrollToBottom = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "auto" });
      }
      messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(t);
  }, [messages, isStreaming, scrollToBottom]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div className="chat-panel" role="log" aria-live="polite" aria-label="Chat history">
      {messages.length > 0 && (
        <div className="chat-toolbar">
          <span className="chat-toolbar-title">Чат</span>
          <div className="chat-toolbar-actions">
            {usage.prompt_tokens + usage.completion_tokens > 0 && (
              <span className="chat-toolbar-usage" title="Использовано токенов за этот сеанс">
                {(usage.prompt_tokens + usage.completion_tokens).toLocaleString("ru-RU")} ток
              </span>
            )}
            <button className="icon-btn" title="Повторить последний запрос" aria-label="Повторить" onClick={retryLastTurn}>
              <RotateCcw size={15} />
            </button>
            <button className="icon-btn" title="Экспортировать чат (Markdown)" aria-label="Экспорт" onClick={exportChat}>
              <Download size={15} />
            </button>
          </div>
        </div>
      )}

      {phase && (
        <div className="agent-status-bar" data-icon={phase.icon}>
          <span className="cf-live-dot" />
          <span className="agent-status-label">{phase.label}</span>
          {planProgress && (
            <span className="agent-status-plan">этап {planProgress.done}/{planProgress.total}</span>
          )}
          {lastMessage?.reasoning && (
            <span className="agent-status-sub">{lastMessage.reasoning.length} симв. рассуждений</span>
          )}
          <span className="agent-status-live">LIVE</span>
        </div>
      )}

      {lastMessage?.role === "assistant" && lastMessage.status === "done" && !isStreaming && (
        <div className="agent-done-bar">
          <CheckCircle2 size={14} />
          <span>Готово</span>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="chat-messages" role="feed">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      <ChatInput />
    </div>
  );
}
