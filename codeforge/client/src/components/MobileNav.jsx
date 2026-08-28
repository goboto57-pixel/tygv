import React from "react";
import { MessageSquare, FolderTree, Search, Settings } from "lucide-react";
import { useFiles } from "../context/FilesContext.jsx";
import { useUI } from "../context/UIContext.jsx";

export default function MobileNav({ view, onChange }) {
  const { files } = useFiles();
  const { setCommandPaletteOpen, setSettingsOpen } = useUI();

  return (
    <div className="mobile-nav">
      <button className={`mobile-nav-btn ${view === "chat" ? "active" : ""}`} onClick={() => onChange("chat")}>
        <MessageSquare size={19} />
        <span>Чат</span>
      </button>
      <button className={`mobile-nav-btn ${view === "files" ? "active" : ""}`} onClick={() => onChange("files")}>
        <FolderTree size={19} />
        <span>Файлы</span>
        {files.length > 0 && <span className="mobile-nav-badge">{files.length}</span>}
      </button>
      <button className="mobile-nav-btn" onClick={() => setCommandPaletteOpen(true)}>
        <Search size={19} />
        <span>Команды</span>
      </button>
      <button className="mobile-nav-btn" onClick={() => setSettingsOpen(true)}>
        <Settings size={19} />
        <span>Настройки</span>
      </button>
    </div>
  );
}
