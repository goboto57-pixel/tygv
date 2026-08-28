import React, { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useChat } from "../context/ChatContext.jsx";
import { useSessions } from "../context/SessionsContext.jsx";
import MessageBubble from "./MessageBubble.jsx";
import ChatInput from "./ChatInput.jsx";
import EmptyState from "./EmptyState.jsx";
import { RotateCcw, Download, CheckCircle2, Search, GitFork, X, Keyboard, Upload } from "lucide-react";

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
  const { messages, isStreaming, retryLastTurn, exportChat, exportPdf, usage, importChat } = useChat();
  const { newChat, setActiveSession } = useSessions();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [regexSearch, setRegexSearch] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const messagesEndRef = useRef(null);
  const rafRef = useRef(null);
  const lastMessage = messages[messages.length - 1];

  const filtered = useMemo(() => {
    if (!search.trim()) return messages;
    if (regexSearch) {
      try {
        const re = new RegExp(search, "i");
        return messages.filter((m) => re.test(m.content || "") || re.test(m.reasoning || ""));
      } catch { return messages; }
    }
    const q = search.toLowerCase();
    return messages.filter((m) => (m.content || "").toLowerCase().includes(q) || (m.reasoning || "").toLowerCase().includes(q));
  }, [messages, search, regexSearch]);

  const forkFrom = useCallback(async (id) => {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const slice = messages.slice(0, idx + 1);
    const newId = await newChat();
    // apply slice to new session after creation
    setTimeout(() => {
      try {
        setActiveSession((prev) => prev ? { ...prev, messages: slice, uiMessages: slice } : prev);
        localStorage.setItem(`codeforge_chat_${newId}`, JSON.stringify({ id: newId, title: slice.find((m) => m.role === "user")?.content?.slice(0, 60) || "Форк", messages: slice, uiMessages: slice, files: [] }));
      } catch {}
    }, 300);
  }, [messages, newChat, setActiveSession]);

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
            {searchOpen && (
              <div className="chat-search">
                <Search size={12} />
                <input autoFocus placeholder={regexSearch ? "Рег. выражение…" : "Поиск в чате…"} value={search} onChange={(e) => setSearch(e.target.value)} />
                <button className={`icon-btn ${regexSearch ? "icon-btn-active" : ""}`} title="Режим регулярного выражения" onClick={() => setRegexSearch((v) => !v)}>.*</button>
                <button className="icon-btn" onClick={() => { setSearch(""); setSearchOpen(false); }}><X size={12} /></button>
              </div>
            )}
            <button className="icon-btn" title="Поиск" onClick={() => setSearchOpen((v) => !v)}><Search size={14} /></button>
            {usage.prompt_tokens + usage.completion_tokens > 0 && (
              <span className="chat-toolbar-usage" title={`Промпт ${usage.prompt_tokens} + ответ ${usage.completion_tokens} = ${usage.prompt_tokens + usage.completion_tokens} токенов`}>
                {(usage.prompt_tokens + usage.completion_tokens).toLocaleString("ru-RU")} ток
              </span>
            )}
            <button className="icon-btn" title="Импортировать чат (JSON)" aria-label="Импорт" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
            </button>
            <input ref={fileInputRef} type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) importChat(f); e.target.value = ""; }} />
            <button className="icon-btn" title="Повторить последний запрос" aria-label="Повторить" onClick={retryLastTurn}>
              <RotateCcw size={15} />
            </button>
            <button className="icon-btn" title="Экспортировать чат (Markdown)" aria-label="Экспорт" onClick={exportChat}>
              <Download size={15} />
            </button>
            <button className="icon-btn" title="Экспорт в PDF (печать)" aria-label="PDF" onClick={exportPdf}>
              <span style={{ fontSize: 11 }}>PDF</span>
            </button>
            <button className="icon-btn" title="Горячие клавиши" aria-label="Горячие клавиши" onClick={() => setShortcutsOpen((v) => !v)}>
              <Keyboard size={15} />
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
            {(search.trim() ? filtered : messages).map((m) => (
              <div key={m.id} className="msg-with-actions">
                <MessageBubble message={m} />
                <button className="msg-fork-btn" onClick={() => forkFrom(m.id)} title="Форкнуть с этого сообщения"><GitFork size={11} /> ветка</button>
              </div>
            ))}
            {search.trim() && filtered.length === 0 && <div className="chat-empty-search">Ничего не найдено</div>}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>
      <ChatInput />
      {shortcutsOpen && (
        <div className="modal-backdrop" onClick={() => setShortcutsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><span>Горячие клавиши</span><button className="icon-btn" onClick={() => setShortcutsOpen(false)}><X size={14} /></button></div>
            <div className="shortcuts-list">
              <div><kbd>Enter</kbd> отправить сообщение</div>
              <div><kbd>Shift + Enter</kbd> новая строка</div>
              <div><kbd>Ctrl/Cmd + S</kbd> сохранить файл</div>
              <div><kbd>Esc</kbd> выход из полноэкранного превью</div>
              <div><kbd>/</kbd> в поле ввода — слэш-команды</div>
              <div><kbd>🔍</kbd> поиск по чату (режим .* — рег. выражения)</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
