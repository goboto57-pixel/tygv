import React, { useState, useEffect, useMemo, useCallback } from "react";
import { X, Trash2, Search, Bookmark, Eraser } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

export default function MemoryModal({ open, onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const scopeId = useMemo(() => {
    try {
      const raw = localStorage.getItem("codeforge_workspace_id");
      if (!raw) return "default";
      // stored as plain string by ChatContext.getWorkspaceId(), not JSON
      return raw;
    } catch {
      return "default";
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/chat/memory/${encodeURIComponent(scopeId)}`);
      const data = await r.json();
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [scopeId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => (e.text || "").toLowerCase().includes(q) || (e.category || "").toLowerCase().includes(q)
    );
  }, [entries, query]);

  const remove = async (id) => {
    try {
      await fetch(`${API_BASE}/chat/memory/${encodeURIComponent(scopeId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch {
      /* ignore */
    }
  };

  const clearAll = async () => {
    if (!confirm("Очистить всю память проекта?")) return;
    try {
      await fetch(`${API_BASE}/chat/memory/${encodeURIComponent(scopeId)}/clear`, { method: "POST" });
      setEntries([]);
    } catch {
      /* ignore */
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal memory-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Память проекта">
        <div className="modal-head">
          <div className="modal-title-group">
            <Bookmark size={16} />
            <span className="modal-title">Память проекта</span>
            <span className="memory-scope">{scopeId}</span>
          </div>
          <div className="modal-head-actions">
            <button className="icon-btn" title="Очистить всё" aria-label="Очистить" onClick={clearAll}>
              <Eraser size={15} />
            </button>
            <button className="icon-btn" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="memory-search">
          <Search size={14} aria-hidden="true" />
          <input
            className="memory-search-input"
            placeholder="Поиск по памяти (семантический фильтр)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="memory-list">
          {loading && <div className="memory-empty">Загрузка…</div>}
          {!loading && filtered.length === 0 && (
            <div className="memory-empty">
              {entries.length === 0 ? "Память пуста. Агент сохраняет сюда важные факты (правила, ограничения, предпочтения)." : "Ничего не найдено."}
            </div>
          )}
          {!loading &&
            filtered.map((e) => (
              <div className="memory-item" key={e.id}>
                <div className="memory-item-head">
                  {e.category && <span className="memory-cat">{e.category}</span>}
                  <span className="memory-key">{String(e.text || "").split("\n")[0].slice(0, 70)}</span>
                  <button className="icon-btn memory-del" title="Удалить" aria-label="Удалить" onClick={() => remove(e.id)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="memory-value">{e.text}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
