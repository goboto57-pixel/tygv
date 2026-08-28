import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { ChevronDown, Brain, User, Sparkles, CheckCircle2, XCircle, BrainCircuit, Pencil } from "lucide-react";
import ToolCallItem from "./ToolCallItem.jsx";
import PlanCard from "./PlanCard.jsx";
import SessionReportPanel from "./SessionReportPanel.jsx";
import { useChat } from "../context/ChatContext.jsx";

export default function MessageBubble({ message }) {
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const { sendMessage } = useChat();
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState(message.content || "");
  const isUser = message.role === "user";
  const hasReasoning = message.reasoning && message.reasoning.trim().length > 0;

  // Auto-open reasoning when streaming starts, auto-keep open while reasoning grows
  const prevReasoningLen = React.useRef(0);
  React.useEffect(() => {
    if (hasReasoning && message.reasoning.length > prevReasoningLen.current) {
      setReasoningOpen(true);
    }
    prevReasoningLen.current = message.reasoning?.length || 0;
  }, [message.reasoning, hasReasoning]);

  // keep editVal in sync if message changes externally
  React.useEffect(() => { setEditVal(message.content || ""); }, [message.content]);

  const hasPlan = !!message.plan;
  const hasTools = message.toolEvents && message.toolEvents.length > 0;
  const isThinking = message.status === "thinking" && !message.content;
  const showTyping = !message.content && !hasReasoning && !hasTools && !hasPlan && !isThinking;
  if (isUser) {
    return (
      <motion.div
        className="msg-row msg-row-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="msg-bubble msg-bubble-user">
          {editing ? (
            <div style={{ display: "flex", gap: 6, width: "100%" }}>
              <input value={editVal} onChange={(e) => setEditVal(e.target.value)} style={{ flex: 1, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "6px 8px", color: "#fff" }} />
              <button className="icon-btn" onClick={() => { setEditing(false); if (editVal.trim() && sendMessage) sendMessage(editVal); }}>↩</button>
              <button className="icon-btn" onClick={() => setEditing(false)}>✕</button>
            </div>
          ) : null}
          {!editing && message.images && message.images.length > 0 && (
            <div className="msg-attached-images">
              {message.images.map((img) => (
                <img key={img.id || img.name} src={img.dataUrl} alt={img.name} className="msg-attached-image" />
              ))}
            </div>
          )}
          {!editing && message.content && <div className="msg-content">{message.content}</div>}
          {!editing && <button className="msg-edit-btn" onClick={() => setEditing(true)} title="Редактировать и отправить снова"><Pencil size={11} /></button>}
        </div>
        <div className="msg-avatar msg-avatar-user">
          <User size={14} />
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="msg-row msg-row-assistant"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="msg-avatar msg-avatar-assistant">
        <Sparkles size={14} />
      </div>
      <div className="msg-bubble msg-bubble-assistant">
        {isThinking && (
          <div className="agent-status" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--accent-bg)", borderRadius: "8px", marginBottom: hasReasoning || hasTools || hasPlan ? 10 : 0, fontSize: "12px", color: "var(--text-secondary)" }}>
            <span className="cf-live-dot" style={{ width: 8, height: 8 }} />
            <span>Агент работает{message.statusText ? `: ${message.statusText}` : hasReasoning ? " — анализирует..." : hasTools ? " — выполняет действия..." : "..."}</span>
            <span style={{ marginLeft: "auto", fontSize: "10px", opacity: 0.7 }}>{hasReasoning ? `${message.reasoning.length} симв.` : ""}</span>
          </div>
        )}
        {hasReasoning && (
          <div className="reasoning-block" style={{ border: "1px solid var(--border-subtle)", borderRadius: "8px", overflow: "hidden", marginBottom: 10 }}>
            <button className="reasoning-toggle" onClick={() => setReasoningOpen((v) => !v)} style={{ width: "100%", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Brain size={13} /> Ход рассуждений {hasReasoning && <span style={{ fontSize: "10px", background: "var(--bg-3)", padding: "2px 6px", borderRadius: 10 }}>{message.reasoning.length > 100 ? `${Math.round(message.reasoning.length/100)/10}k` : message.reasoning.length}</span>}</span>
              <ChevronDown
                size={14}
                className="reasoning-chevron"
                style={{ transform: reasoningOpen ? "rotate(180deg)" : "rotate(0deg)" }}
              />
            </button>
            <AnimatePresence initial={false}>
              {reasoningOpen && (
                <motion.div
                  className="reasoning-text"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="reasoning-text-inner" style={{ whiteSpace: "pre-wrap", maxHeight: "240px", overflowY: "auto" }}>{message.reasoning}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        {!hasReasoning && isThinking && (
          <div style={{ fontSize: "11px", color: "var(--text-tertiary)", fontStyle: "italic", marginBottom: 8, padding: "6px 8px", background: "var(--bg-1)", borderRadius: 6 }}>
            Агент анализирует задачу и готовит план... (рассуждения появятся здесь)
          </div>
        )}

        {message.promptEnhancement && (
          <details className="cf-prompt-enhanced">
            <summary>Промпт уточнён перед выполнением</summary>
            <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>{message.promptEnhancement.enhanced}</div>
          </details>
        )}

        {message.council && (
          <div className="cf-council-panel">
            <div className="cf-council-head">
              {message.council.status === "thinking" ? (
                <>
                  <span className="cf-live-dot" /> Совет: Gemini и Mistral Large анализируют задачу…
                </>
              ) : message.council.status === "error" ? (
                <>Совет: ошибка — {message.council.message}</>
              ) : (
                <>Совет: согласованное решение</>
              )}
            </div>
            {message.council.decision && <div className="cf-council-decision">{message.council.decision}</div>}
          </div>
        )}

        {message.subagents && message.subagents.length > 0 && (
          <div className="cf-subagents">
            {message.subagents.map((sa, i) => (
              <div className="cf-subagent-item" key={i}>
                <div className="cf-subagent-head">
                  {sa.status === "running" ? <span className="cf-live-dot" /> : "✓"} Субагент Devstral
                </div>
                <div>{sa.task}</div>
                {sa.report && (
                  <div style={{ marginTop: 6, color: "var(--text-secondary)" }}>{sa.report}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {message.plan && <PlanCard plan={message.plan} />}

        {message.toolEvents && message.toolEvents.length > 0 && (
          <div className="tool-events">
            {message.toolEvents
              .filter((e) => e.name !== "make_plan")
              .map((evt, i) => (
                <ToolCallItem key={i} event={evt} />
              ))}
          </div>
        )}

        {message.testRuns && message.testRuns.length > 0 && (
          <div className="test-run-list">
            {message.testRuns.map((t, i) => (
              <div key={i} className={`test-run-badge ${t.ok ? "pass" : "fail"}`}>
                <CheckCircle2 size={13} style={{ display: t.ok ? "inline" : "none" }} />
                <XCircle size={13} style={{ display: t.ok ? "none" : "inline" }} />
                <span className="test-run-cmd">{t.command}</span>
                <span className="test-run-stat">
                  {t.timedOut
                    ? "таймаут"
                    : t.total != null
                    ? `${t.passed}/${t.total} прошли`
                    : t.ok
                    ? "прошли"
                    : "упали"}
                </span>
              </div>
            ))}
          </div>
        )}

        {message.content && (
          <div className="msg-content markdown-body">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}

        {message.memorySaved && message.memorySaved.length > 0 && (
          <div className="memory-saved-list">
            {message.memorySaved.map((e) => (
              <div key={e.id} className="memory-saved-item">
                <BrainCircuit size={12} />
                <span>Сохранено в память проекта: {e.text}</span>
              </div>
            ))}
          </div>
        )}

        {message.sessionReport && <SessionReportPanel report={message.sessionReport} />}

        {showTyping && (
          <div className="typing-indicator">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </motion.div>
  );
}
