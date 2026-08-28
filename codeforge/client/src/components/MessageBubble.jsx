import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { ChevronDown, Brain, User, Sparkles, CheckCircle2, XCircle, BrainCircuit } from "lucide-react";
import ToolCallItem from "./ToolCallItem.jsx";
import PlanCard from "./PlanCard.jsx";
import SessionReportPanel from "./SessionReportPanel.jsx";

export default function MessageBubble({ message }) {
  const [reasoningOpen, setReasoningOpen] = useState(true);
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

  if (isUser) {
    return (
      <motion.div
        className="msg-row msg-row-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="msg-bubble msg-bubble-user">
          {message.images && message.images.length > 0 && (
            <div className="msg-attached-images">
              {message.images.map((img) => (
                <img key={img.id || img.name} src={img.dataUrl} alt={img.name} className="msg-attached-image" />
              ))}
            </div>
          )}
          {message.content && <div className="msg-content">{message.content}</div>}
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
        {hasReasoning && (
          <div className="reasoning-block">
            <button className="reasoning-toggle" onClick={() => setReasoningOpen((v) => !v)}>
              <Brain size={13} />
              <span>Ход рассуждений</span>
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
                  <div className="reasoning-text-inner">{message.reasoning}</div>
                </motion.div>
              )}
            </AnimatePresence>
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

        {!message.content && !hasReasoning && (!message.toolEvents || message.toolEvents.length === 0) && (
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
