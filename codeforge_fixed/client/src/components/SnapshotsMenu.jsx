import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { History, RotateCcw, GitCompare, X as XIcon } from "lucide-react";
import { useSessions } from "../context/SessionsContext.jsx";

export default function SnapshotsMenu({ onClose }) {
  const { snapshots, loadSnapshots, restoreSnapshot, diffSnapshots } = useSessions();
  const [compareFrom, setCompareFrom] = useState(null);
  const [diffResult, setDiffResult] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const handleClickSnapshot = async (snapshot) => {
    if (!compareFrom) {
      setCompareFrom(snapshot);
      return;
    }
    if (compareFrom.id === snapshot.id) {
      setCompareFrom(null);
      return;
    }
    setDiffLoading(true);
    // snapshots array here is newest-first (as returned by the API); pass
    // whichever was picked earlier as "from" and the second as "to" using
    // real snapshot ids, which the server resolves unambiguously.
    const result = await diffSnapshots(compareFrom.id, snapshot.id);
    setDiffLoading(false);
    setDiffResult(result ? { ...result, fromLabel: compareFrom.label, toLabel: snapshot.label } : null);
    setCompareFrom(null);
  };

  return (
    <motion.div
      className="snapshots-menu"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
    >
      <div className="snapshots-menu-header">
        <History size={14} />
        <span>Версии проекта</span>
        {compareFrom && (
          <span className="snapshots-compare-hint">
            <GitCompare size={12} /> Выберите вторую версию для сравнения с «{compareFrom.label}»
          </span>
        )}
      </div>
      {snapshots.length === 0 ? (
        <div className="snapshots-empty">Снимков пока нет</div>
      ) : (
        snapshots.map((s) => (
          <div key={s.id} className={`snapshot-item-row ${compareFrom?.id === s.id ? "snapshot-item-selected" : ""}`}>
            <button className="snapshot-item" onClick={() => restoreSnapshot(s)}>
              <RotateCcw size={13} />
              <div>
                <div className="snapshot-label">{s.label}</div>
                <div className="snapshot-date">{new Date(s.createdAt).toLocaleString("ru-RU")}</div>
              </div>
            </button>
            <button
              className="snapshot-compare-btn"
              title="Сравнить с другой версией"
              onClick={() => handleClickSnapshot(s)}
            >
              <GitCompare size={13} />
            </button>
          </div>
        ))
      )}

      {diffLoading && <div className="snapshots-diff-loading">Считаю diff…</div>}

      {diffResult && (
        <div className="snapshots-diff-panel">
          <div className="snapshots-diff-panel-header">
            <span>
              {diffResult.toLabel} ← {diffResult.fromLabel}
            </span>
            <button onClick={() => setDiffResult(null)} title="Закрыть diff">
              <XIcon size={13} />
            </button>
          </div>
          {diffResult.note ? (
            <div className="snapshots-empty">{diffResult.note}</div>
          ) : diffResult.error ? (
            <div className="snapshots-empty">{diffResult.error}</div>
          ) : (
            <>
              <pre className="snapshots-diff-stat">{diffResult.stat}</pre>
              <pre className="snapshots-diff-patch">{diffResult.diff || "Нет изменений между этими версиями."}</pre>
            </>
          )}
        </div>
      )}
    </motion.div>
  );
}
