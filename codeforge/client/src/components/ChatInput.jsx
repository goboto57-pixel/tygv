import React, { useState, useRef, useCallback } from "react";
import { Paperclip, ArrowUp, Square, Mic, X } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

export default function ChatInput() {
  const { sendMessage, isStreaming, stopStreaming, uploadFiles, files } = useApp();
  const [value, setValue] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handleSend = () => {
    if (!value.trim() || isStreaming) return;
    sendMessage(value);
    setValue("");
    requestAnimationFrame(autoResize);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  };

  const toggleVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      setValue((prev) => (prev ? prev + " " + transcript : transcript));
      requestAnimationFrame(autoResize);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setIsRecording(true);
  };

  return (
    <div
      className={`chat-input-wrap ${isDragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      {files.length > 0 && (
        <div className="attached-files-strip">
          {files.slice(0, 6).map((f) => (
            <span key={f.path} className="attached-chip">
              {f.path.split("/").pop()}
            </span>
          ))}
          {files.length > 6 && <span className="attached-chip">+{files.length - 6}</span>}
        </div>
      )}

      <div className="chat-input-box">
        <button
          className="chat-input-icon-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Прикрепить файлы"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          multiple
          hidden
          onChange={(e) => e.target.files?.length && uploadFiles(e.target.files)}
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Опишите задачу для агента..."
          rows={1}
        />

        <button
          className={`chat-input-icon-btn ${isRecording ? "recording" : ""}`}
          onClick={toggleVoice}
          title="Голосовой ввод"
        >
          <Mic size={18} />
        </button>

        {isStreaming ? (
          <button className="chat-send-btn stop" onClick={stopStreaming} title="Остановить">
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!value.trim()}
            title="Отправить"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>

      {isDragging && (
        <div className="drop-overlay">
          <span>Отпустите, чтобы прикрепить файлы</span>
        </div>
      )}
    </div>
  );
}
