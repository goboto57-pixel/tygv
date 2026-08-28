import React, { useMemo } from "react";
import { useFiles } from "../context/FilesContext.jsx";
import { useChat } from "../context/ChatContext.jsx";
import { FileText, Code2, Hash, Zap, Clock, Database } from "lucide-react";

export default function StatsDashboard() {
  const { files } = useFiles();
  const { messages, usage } = useChat();

  const stats = useMemo(() => {
    const totalLines = files.reduce((acc, f) => acc + (f.content?.split("\n").length || 0), 0);
    const totalChars = files.reduce((acc, f) => acc + (f.content?.length || 0), 0);
    const byExt = {};
    files.forEach(f => {
      const ext = f.path.split(".").pop().toLowerCase();
      byExt[ext] = (byExt[ext] || 0) + 1;
    });
    const topExt = Object.entries(byExt).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const avgFile = files.length ? Math.round(totalLines / files.length) : 0;
    return { totalLines, totalChars, byExt, topExt, avgFile, fileCount: files.length, messageCount: messages.length, totalTokens: usage.prompt_tokens + usage.completion_tokens };
  }, [files, messages, usage]);

  if (files.length === 0) return null;

  return (
    <div className="stats-dashboard">
      <h3 style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)", margin: "12px 0 8px" }}>Статистика проекта</h3>
      <div className="stats-grid">
        <div className="stats-card">
          <div className="stats-card-value">{stats.fileCount}</div>
          <div className="stats-card-label"><FileText size={10} style={{display:"inline",marginRight:4}}/>Файлов</div>
          <div className="stats-bar"><div className="stats-bar-fill" style={{width: `${Math.min(100, stats.fileCount*4)}%`}}/></div>
        </div>
        <div className="stats-card">
          <div className="stats-card-value">{stats.totalLines.toLocaleString("ru-RU")}</div>
          <div className="stats-card-label"><Hash size={10} style={{display:"inline",marginRight:4}}/>Строк кода</div>
          <div className="stats-bar"><div className="stats-bar-fill" style={{width: `${Math.min(100, stats.totalLines/20)}%`}}/></div>
        </div>
        <div className="stats-card">
          <div className="stats-card-value">{(stats.totalChars/1024).toFixed(1)}KB</div>
          <div className="stats-card-label"><Database size={10} style={{display:"inline",marginRight:4}}/>Размер</div>
        </div>
        <div className="stats-card">
          <div className="stats-card-value">{stats.totalTokens.toLocaleString("ru-RU")}</div>
          <div className="stats-card-label"><Zap size={10} style={{display:"inline",marginRight:4}}/>Токенов</div>
        </div>
      </div>
      {stats.topExt.length > 0 && (
        <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: 8 }}>
          Топ: {stats.topExt.map(([ext, n]) => `${ext}(${n})`).join(" · ")} · Средн. {stats.avgFile} строк/файл
        </div>
      )}
    </div>
  );
}
