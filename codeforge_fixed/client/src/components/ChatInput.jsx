import React, { useState, useRef, useCallback } from "react";
import { Paperclip, ArrowUp, Square, Mic, Loader2, Image as ImageIcon, X, ChevronDown, Check } from "lucide-react";
import { useChat } from "../context/ChatContext.jsx";
import { useFiles } from "../context/FilesContext.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import { useUI } from "../context/UIContext.jsx";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Pick a mime type MediaRecorder actually supports in this browser, falling
// back to the browser default (undefined) if none of the preferred ones are.
function pickRecorderMimeType() {
  const candidates = ["audio/webm", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return undefined;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t));
}

function ModelPicker() {
  const { settings, updateSettings, MODELS } = useSettings();
  const [open, setOpen] = useState(false);
  const active = MODELS.find((m) => m.id === settings.model) || MODELS[0];

  return (
    <div className="model-picker">
      <button className="model-picker-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="model-picker-dot" />
        {active.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="model-picker-backdrop" onClick={() => setOpen(false)} />
          <div className="model-picker-menu">
            {MODELS.map((m) => (
              <button
                key={m.id}
                className={`model-picker-item ${m.id === settings.model ? "active" : ""} ${m.disabled ? "disabled" : ""}`}
                disabled={m.disabled}
                onClick={() => {
                  updateSettings({ model: m.id });
                  setOpen(false);
                }}
              >
                <div>
                  <div className="model-picker-item-name">{m.label}</div>
                  <div className="model-picker-item-desc">{m.provider} · {m.desc}</div>
                </div>
                {m.id === settings.model && <Check size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Segmented control for toolMode: Code / Search / Premium Search / Image —
// same set of built-in capabilities exposed in the console.mistral.ai
// playground ("Built-in tools" row).
function ToolModePicker() {
  const { settings, updateSettings, TOOL_MODES } = useSettings();
  const active = settings.toolMode || "code";
  return (
    <div className="tool-mode-picker" title="Режим: код / поиск / изображение">
      {TOOL_MODES.map((t) => (
        <button
          key={t.id}
          className={`tool-mode-item ${active === t.id ? "active" : ""}`}
          title={t.desc}
          onClick={() => updateSettings({ toolMode: t.id })}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// Reasoning effort toggle — only meaningful for models that support
// reasoning_effort (Magistral, Mistral Small 4/latest); harmless no-op for
// models that don't (server silently drops it for unsupported models).
function EffortPicker() {
  const { settings, updateSettings, REASONING_EFFORTS, MODELS } = useSettings();
  const active = settings.reasoningEffort || "none";
  const activeModel = MODELS.find((m) => m.id === settings.model);
  const [open, setOpen] = useState(false);
  const current = REASONING_EFFORTS.find((e) => e.id === active) || REASONING_EFFORTS[0];
  return (
    <div className="model-picker">
      <button className="model-picker-trigger" onClick={() => setOpen((o) => !o)} title={activeModel?.reasoning ? "Глубина рассуждения" : "Эффорт применяется только к reasoning-моделям"}>
        {current.label}
        <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="model-picker-backdrop" onClick={() => setOpen(false)} />
          <div className="model-picker-menu">
            {REASONING_EFFORTS.map((e) => (
              <button
                key={e.id}
                className={`model-picker-item ${e.id === active ? "active" : ""}`}
                onClick={() => { updateSettings({ reasoningEffort: e.id }); setOpen(false); }}
              >
                <div>
                  <div className="model-picker-item-name">{e.label}</div>
                  {e.desc && <div className="model-picker-item-desc">{e.desc}</div>}
                </div>
                {e.id === active && <Check size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function ChatInput() {
  const { sendMessage, isStreaming, stopStreaming, getRecentPrompts } = useChat();
  const { uploadFiles, files } = useFiles();
  const { settings } = useSettings();
  const { notify } = useUI();
  const [value, setValue] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingImages, setPendingImages] = useState([]); // [{id, name, dataUrl}] — vision reference attachments
  const [pendingFiles, setPendingFiles] = useState([]); // [{id, name, path}] — files just attached, will be visible to agent via project files
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef(null);
  const streamRef = useRef(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const recentPrompts = recentOpen ? getRecentPrompts() : [];

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per image, keeps base64 payload reasonable

  const readImageAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const addImages = useCallback(
    async (fileList) => {
      const incoming = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
      if (!incoming.length) return;
      const room = MAX_IMAGES - pendingImages.length;
      if (room <= 0) {
        notify(`Можно приложить не больше ${MAX_IMAGES} изображений`, "error");
        return;
      }
      const accepted = [];
      for (const file of incoming.slice(0, room)) {
        if (file.size > MAX_IMAGE_BYTES) {
          notify(`${file.name}: слишком большой файл (макс. 8MB)`, "error");
          continue;
        }
        try {
          const dataUrl = await readImageAsDataUrl(file);
          accepted.push({ id: `${file.name}-${file.size}-${Date.now()}`, name: file.name, dataUrl });
        } catch {
          notify(`Не удалось прочитать ${file.name}`, "error");
        }
      }
      if (accepted.length) setPendingImages((prev) => [...prev, ...accepted]);
    },
    [pendingImages.length, notify]
  );

  const removeImage = (id) => setPendingImages((prev) => prev.filter((img) => img.id !== id));

  const handleSend = () => {
    const trimmed = value.trim();
    // slash commands
    if (trimmed.startsWith("/")) {
      const cmd = trimmed.split(/\s+/)[0].toLowerCase();
      if (cmd === "/clear") { setValue(""); setPendingImages([]); setPendingFiles([]); notify?.("Чат очищен (локально)", "info"); return; }
      if (cmd === "/stats") { const s = files.length; notify?.(`Файлов: ${s}`, "info"); return; }
      if (cmd === "/fork") { window.dispatchEvent(new CustomEvent("codeforge:new-chat")); notify?.("Новая ветка", "success"); return; }
    }
    if ((!value.trim() && pendingImages.length === 0 && pendingFiles.length === 0) || isStreaming) return;
    let msg = value;
    if (pendingFiles.length) {
      const list = pendingFiles.map((f) => f.path).join(", ");
      msg = msg ? `${msg}\n\n[Прикреплённые файлы: ${list} — смотри в проекте]` : `Посмотри файлы: ${list}`;
    }
    sendMessage(msg, pendingImages);
    setValue("");
    setPendingImages([]);
    setPendingFiles([]);
    requestAnimationFrame(autoResize);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && settings.sendOnEnter) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files;
    if (!dropped?.length) return;
    const images = Array.from(dropped).filter((f) => f.type.startsWith("image/"));
    const rest = Array.from(dropped).filter((f) => !f.type.startsWith("image/"));
    if (images.length) addImages(images);
    if (rest.length) {
      const ids = rest.map((f) => ({ id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, name: f.name, path: f.name }));
      setPendingFiles((prev) => [...prev, ...ids].slice(0, 10));
      uploadFiles(rest);
    }
  };

  // Voice input: record via MediaRecorder, then ship the audio to the
  // server for transcription by Mistral Voxtral (server/services/mistralClient.js).
  // This runs through Mistral rather than the browser's built-in speech
  // recognizer, so it works consistently across browsers and gives
  // transcription quality tied to the same model family as the agent.
  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      notify("Микрофон недоступен в этом браузере", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stopTracks();
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        audioChunksRef.current = [];
        if (blob.size < 500) return; // essentially empty recording, skip the round trip

        setIsTranscribing(true);
        try {
          const formData = new FormData();
          const ext = (recorder.mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
          formData.append("audio", blob, `voice-input.${ext}`);
          const res = await fetch(`${API_BASE}/chat/transcribe`, { method: "POST", body: formData });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          if (data.text) {
            setValue((prev) => (prev ? prev + " " + data.text : data.text));
            requestAnimationFrame(autoResize);
          }
        } catch (err) {
          notify(`Не удалось распознать голос: ${err.message}`, "error");
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      notify("Нет доступа к микрофону", "error");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setIsRecording(false);
  };

  const toggleVoice = () => {
    if (isTranscribing) return;
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
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
      {(files.length > 0 || pendingFiles.length > 0) && (
        <div className="attached-files-strip">
          {pendingFiles.map((f) => (
            <span key={f.id} className="attached-chip pending" title="Будет отправлено с сообщением">
              {f.name} •
            </span>
          ))}
          {files.slice(0, 6).map((f) => (
            <span key={f.path} className="attached-chip">
              {f.path.split("/").pop()}
            </span>
          ))}
          {files.length > 6 && <span className="attached-chip">+{files.length - 6}</span>}
          {pendingFiles.length > 0 && (
            <button className="attached-chip" onClick={() => setPendingFiles([])} title="Очистить прикреплённые">
              <X size={10} /> очистить
            </button>
          )}
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="attached-images-strip">
          {pendingImages.map((img) => (
            <div key={img.id} className="attached-image-thumb" title={img.name}>
              <img src={img.dataUrl} alt={img.name} />
              <button className="attached-image-remove" onClick={() => removeImage(img.id)} title="Убрать">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-box">
        <button
          className="chat-input-icon-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Прикрепить файлы проекта"
        >
          <Paperclip size={18} />
        </button>
        <input
          type="file"
          ref={fileInputRef}
          multiple
          hidden
          onChange={(e) => {
            if (!e.target.files?.length) return;
            const list = Array.from(e.target.files);
            const ids = list.map((f) => ({ id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, name: f.name, path: f.name }));
            setPendingFiles((prev) => [...prev, ...ids].slice(0, 10));
            uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />

        <button
          className="chat-input-icon-btn"
          onClick={() => imageInputRef.current?.click()}
          title="Приложить референс-изображение (дизайн, скриншот) — анализируется через Mistral Pixtral"
          disabled={pendingImages.length >= MAX_IMAGES}
        >
          <ImageIcon size={18} />
        </button>
        <input
          type="file"
          ref={imageInputRef}
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addImages(e.target.files);
            e.target.value = "";
          }}
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
          disabled={isTranscribing}
          title={isTranscribing ? "Распознавание..." : isRecording ? "Остановить запись" : "Голосовой ввод (Mistral Voxtral)"}
        >
          {isTranscribing ? <Loader2 size={18} className="spin" /> : <Mic size={18} />}
        </button>

        {isStreaming ? (
          <button className="chat-send-btn stop" onClick={stopStreaming} title="Остановить">
            <Square size={15} fill="currentColor" />
          </button>
        ) : (
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!value.trim() && pendingImages.length === 0}
            title="Отправить"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>

      <div className="chat-input-footer">
        <ModelPicker />
        <ToolModePicker />
        <EffortPicker />
        <button className="chat-input-recent" title="Недавние запросы" onClick={() => setRecentOpen((v) => !v)}>↺ недавние</button>
        {recentOpen && (
          <div className="recent-prompts-pop">
            {recentPrompts.length === 0 && <div className="recent-empty">Нет недавних запросов</div>}
            {recentPrompts.map((p, i) => (
              <button key={i} className="recent-prompt-item" onClick={() => { setValue(p); setRecentOpen(false); requestAnimationFrame(autoResize); }}>{p.slice(0, 80)}</button>
            ))}
          </div>
        )}
        <span className="chat-input-footer-sep">/</span>
        <span className="chat-input-footer-project">Default Project</span>
      </div>

      {isDragging && (
        <div className="drop-overlay">
          <span>Отпустите — изображения станут референсом, остальное добавится в проект</span>
        </div>
      )}
    </div>
  );
}
