import React, { useState } from "react";
import { Menu, Gauge, Camera, Download, Search, Settings } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";
import SnapshotsMenu from "./SnapshotsMenu.jsx";
import { exportZip } from "../utils/exportZip.js";

export default function TopBar({ onMenuClick, isMobile }) {
  const {
    usage,
    files,
    chatId,
    takeSnapshot,
    setCommandPaletteOpen,
    setSettingsOpen,
    settings,
    MODELS
  } = useApp();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);

  const totalTokens = usage.prompt_tokens + usage.completion_tokens;
  const estCost = ((usage.prompt_tokens / 1_000_000) * 0.3 + (usage.completion_tokens / 1_000_000) * 0.9).toFixed(4);
  const activeModel = MODELS.find((m) => m.id === settings.model);

  return (
    <div className="topbar">
      {isMobile && (
        <button className="icon-btn" onClick={onMenuClick} aria-label="Меню">
          <Menu size={20} />
        </button>
      )}

      <div className="topbar-status">
        <span className="status-dot" />
        <span className="topbar-status-text">Агент готов</span>
        {!isMobile && activeModel && <span className="topbar-model-chip">{activeModel.label}</span>}
      </div>

      <div className="topbar-actions">
        {!isMobile && (
          <button className="icon-btn" onClick={() => setCommandPaletteOpen(true)} title="Палитра команд (Ctrl/Cmd+K)">
            <Search size={16} />
          </button>
        )}

        <div className="usage-pill" title="Токены и примерная стоимость">
          <Gauge size={13} />
          <span>{totalTokens.toLocaleString("ru-RU")}</span>
          <span className="usage-cost">${estCost}</span>
        </div>

        <button
          className="icon-btn"
          onClick={() => takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`)}
          title="Сохранить снимок версии"
          disabled={files.length === 0}
        >
          <Camera size={17} />
        </button>

        <button
          className="icon-btn"
          onClick={() => exportZip(files, `codeforge-${chatId.slice(0, 8)}`)}
          title="Скачать проект (.zip)"
          disabled={files.length === 0}
        >
          <Download size={17} />
        </button>

        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Настройки">
          <Settings size={17} />
        </button>
      </div>

      {snapshotsOpen && <SnapshotsMenu onClose={() => setSnapshotsOpen(false)} />}
    </div>
  );
}
