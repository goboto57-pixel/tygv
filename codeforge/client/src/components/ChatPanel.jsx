import React, { useRef, useEffect, useCallback } from "react";
import { useChat } from "../context/ChatContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import MessageBubble from "./MessageBubble.jsx";
import ChatInput from "./ChatInput.jsx";
import EmptyState from "./EmptyState.jsx";

export default function ChatPanel() {
  const { messages, isStreaming } = useChat();
  const scrollRef = useRef(null);
  const messagesEndRef = useRef(null);
  const rafRef = useRef(null);

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
    // Throttle scroll during streaming to avoid jank
    const t = setTimeout(scrollToBottom, 100);
    return () => clearTimeout(t);
  }, [messages, isStreaming, scrollToBottom]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  return (
    <div className="chat-panel" role="log" aria-live="polite" aria-label="Chat history">
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
