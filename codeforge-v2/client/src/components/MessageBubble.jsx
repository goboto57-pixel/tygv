import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { ChevronDown, Brain, User, Sparkles } from "lucide-react";
import ToolCallItem from "./ToolCallItem.jsx";
import PlanCard from "./PlanCard.jsx";

export default function MessageBubble({ message }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const isUser = message.role === "user";
  const hasReasoning = message.reasoning && message.reasoning.trim().length > 0;

  if (isUser) {
    return (
      <motion.div
        className="msg-row msg-row-user"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="msg-bubble msg-bubble-user">
          <div className="msg-content">{message.content}</div>
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

        {message.content && (
          <div className="msg-content markdown-body">
            <ReactMarkdown>{message.content}</ReactMarkdown>
          </div>
        )}

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
