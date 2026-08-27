import React, { useRef, useEffect } from "react";
import { useApp } from "../context/AppContext.jsx";
import MessageBubble from "./MessageBubble.jsx";
import ChatInput from "./ChatInput.jsx";
import EmptyState from "./EmptyState.jsx";

export default function ChatPanel() {
  const { messages, isStreaming } = useApp();
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages, isStreaming]);

  return (
    <div className="chat-panel">
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="chat-messages">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
      <ChatInput />
    </div>
  );
}
