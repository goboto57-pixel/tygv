import React, { useEffect } from "react";
import { motion } from "framer-motion";
import { History, RotateCcw } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

export default function SnapshotsMenu({ onClose }) {
  const { snapshots, loadSnapshots, restoreSnapshot } = useApp();

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

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
      </div>
      {snapshots.length === 0 ? (
        <div className="snapshots-empty">Снимков пока нет</div>
      ) : (
        snapshots.map((s) => (
          <button key={s.id} className="snapshot-item" onClick={() => restoreSnapshot(s)}>
            <RotateCcw size={13} />
            <div>
              <div className="snapshot-label">{s.label}</div>
              <div className="snapshot-date">{new Date(s.createdAt).toLocaleString("ru-RU")}</div>
            </div>
          </button>
        ))
      )}
    </motion.div>
  );
}
