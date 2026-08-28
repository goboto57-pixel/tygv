import React from "react";
import { FileEdit, FilePlus, FileX, Search, ListTree, Terminal, Loader2, Check } from "lucide-react";

const ICONS = {
  write_file: FilePlus,
  edit_file: FileEdit,
  delete_file: FileX,
  search_code: Search,
  list_files: ListTree,
  read_file: FileEdit,
  run_command: Terminal
};

const LABELS = {
  write_file: "Создание файла",
  edit_file: "Изменение файла",
  delete_file: "Удаление файла",
  search_code: "Поиск по коду",
  list_files: "Список файлов",
  read_file: "Чтение файла",
  run_command: "Выполнение команды"
};

export default function ToolCallItem({ event }) {
  const Icon = ICONS[event.name] || Terminal;
  const label = LABELS[event.name] || event.name;
  const target = event.args?.path || event.args?.query || event.args?.command || "";

  return (
    <div className={`tool-call-item ${event.status === "done" ? "done" : "running"}`}>
      <div className="tool-call-icon">
        {event.status === "running" ? <Loader2 size={13} className="spin" /> : <Icon size={13} />}
      </div>
      <span className="tool-call-label">{label}</span>
      {target && <code className="tool-call-target">{target}</code>}
      {event.status === "done" && (
        <span className="tool-call-dur">
          {event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : ""}
          <Check size={12} className="tool-call-check" />
        </span>
      )}
    </div>
  );
}
