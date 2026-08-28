import React, { useState, useMemo } from "react";
import { Menu, Gauge, Camera, Download, Search, Settings, PanelLeft, PanelRight, Focus, BarChart3 } from "lucide-react";
import { useChat } from "../context/ChatContext.jsx";
import { useFiles } from "../context/FilesContext.jsx";
import { useSessions } from "../context/SessionsContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import SnapshotsMenu from "./SnapshotsMenu.jsx";
import StatsDashboard from "./StatsDashboard.jsx";
import { exportZip } from "../utils/exportZip.js";

export default function TopBar({ onMenuClick, onFilesClick, leftSidebarOpen, rightPanelOpen, isMobile }) {
  const { usage, isStreaming } = useChat();
  const { files, chatId } = useFiles();
  const { takeSnapshot } = useSessions();
  const { setCommandPaletteOpen, setSettingsOpen, focusMode, setFocusMode } = useUI();
  const { settings, MODELS } = useSettings();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  const totalTokens = usage.prompt_tokens + usage.completion_tokens;
  const estCost = useMemo(
    () => ((usage.prompt_tokens / 1_000_000) * 0.3 + (usage.completion_tokens / 1_000_000) * 0.9).toFixed(4),
    [usage.prompt_tokens, usage.completion_tokens]
  );
  const activeModel = useMemo(() => MODELS.find((m) => m.id === settings.model), [MODELS, settings.model]);

  return (
    <header className="topbar" role="banner">
      <button
        className={`icon-btn ${leftSidebarOpen ? "icon-btn-active" : ""}`}
        onClick={onMenuClick}
        title="История чатов (Ctrl/Cmd+B)"
        aria-label={leftSidebarOpen ? "Закрыть меню" : "Открыть меню"}
        aria-expanded={leftSidebarOpen}
        aria-controls="sidebar"
      >
        {isMobile ? <Menu size={20} /> : <PanelLeft size={17} />}
      </button>

      <div className={`topbar-status ${isStreaming ? "streaming" : ""}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span className="topbar-status-text">{isStreaming ? "Агент работает…" : "Агент готов"}</span>
        {!isMobile && activeModel && <span className="topbar-model-chip">{activeModel.label}</span>}
      </div>

      <div className="topbar-actions" role="group" aria-label="Toolbar actions">
        {!isMobile && (
          <button className="icon-btn" onClick={() => setCommandPaletteOpen(true)} title="Палитра команд (Ctrl/Cmd+K)" aria-label="Команды">
            <Search size={16} />
          </button>
        )}

        <div className="usage-pill" role="status" aria-label={`Использовано токенов: ${totalTokens.toLocaleString("ru-RU")}, стоимость: $${estCost}`}>
          <Gauge size={13} aria-hidden="true" />
          <span>{totalTokens.toLocaleString("ru-RU")}</span>
          <span className="usage-cost">${estCost}</span>
        </div>

        <button
          className="icon-btn"
          onClick={() => takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`, files)}
          title="Сохранить снимок версии"
          disabled={files.length === 0}
          aria-disabled={files.length === 0}
          aria-label="Сохранить снимок версии"
        >
          <Camera size={17} />
        </button>

        <button
          className="icon-btn"
          onClick={() => exportZip(files, `codeforge-${(chatId || "project").slice(0, 8)}`)}
          title="Скачать проект (.zip)"
          disabled={files.length === 0}
          aria-disabled={files.length === 0}
          aria-label="Скачать проект как ZIP"
        >
          <Download size={17} />
        </button>

        <button
          className={`icon-btn ${rightPanelOpen ? "icon-btn-active" : ""}`}
          onClick={onFilesClick}
          title="Панель файлов (Ctrl/Cmd+J)"
          aria-label={rightPanelOpen ? "Закрыть панель файлов" : "Открыть панель файлов"}
          aria-expanded={rightPanelOpen}
          aria-controls="files-panel"
        >
          <PanelRight size={17} />
          {!rightPanelOpen && files.length > 0 && <span className="file-count icon-btn-badge" aria-label={`${files.length} открытых файлов`}>{files.length}</span>}
        </button>

        <button className={`icon-btn ${focusMode ? "icon-btn-active focus-toggle" : ""}`} onClick={() => { const v = !focusMode; setFocusMode(v); document.querySelector(".shell")?.classList.toggle("focus-mode", v); }} title={focusMode ? "Выйти из фокус режима" : "Фокус режим (Zen)"} aria-label="Фокус режим">
          <Focus size={17} />
        </button>
        <button className="icon-btn" onClick={() => setStatsOpen(v=>!v)} title="Статистика проекта" aria-label="Статистика">
          <BarChart3 size={17} />
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Настройки" aria-label="Настройки">
          <Settings size={17} />
        </button>
      </div>

      {snapshotsOpen && <SnapshotsMenu onClose={() => setSnapshotsOpen(false)} />}
      {statsOpen && (
        <div style={{ position: "absolute", top: "52px", right: "12px", width: "min(360px, 92vw)", background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: "12px", padding: "12px", zIndex: 50, boxShadow: "var(--shadow-lg)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: "13px" }}>Статистика</strong>
            <button className="icon-btn" onClick={()=>setStatsOpen(false)}>×</button>
          </div>
          <StatsDashboard />
        </div>
      )}
    </header>
  );
}
