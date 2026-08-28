import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileEdit, FilePlus, FileX, Check, X } from "lucide-react";
import DiffViewer from "./DiffViewer.jsx";
import { useChat } from "../context/ChatContext.jsx";

const KIND_META = {
  write_file: { icon: FilePlus, label: "Создание/перезапись файла" },
  edit_file: { icon: FileEdit, label: "Изменение файла" },
  delete_file: { icon: FileX, label: "Удаление файла" }
};

export default function DiffApprovalModal() {
  const { pendingDiff, resolveDiff } = useChat();

  return (
    <AnimatePresence>
      {pendingDiff && (
        <>
          <motion.div
            className="sidebar-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            className="diff-approval-modal"
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <DiffApprovalBody diff={pendingDiff} onDecide={resolveDiff} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function DiffApprovalBody({ diff, onDecide }) {
  const meta = KIND_META[diff.kind] || KIND_META.edit_file;
  const Icon = meta.icon;
  const isDelete = diff.kind === "delete_file";
  const isNew = diff.kind === "write_file" && !diff.before;

  return (
    <div className="diff-approval-card">
      <div className="diff-approval-header">
        <Icon size={16} />
        <div className="diff-approval-header-text">
          <span className="diff-approval-kind">{meta.label}</span>
          <code className="diff-approval-path">{diff.path}</code>
        </div>
      </div>

      <div className="diff-approval-body">
        {isDelete ? (
          <div className="diff-approval-delete-notice">
            Агент хочет удалить этот файл. Текущее содержимое будет потеряно, если не отклонить.
          </div>
        ) : isNew ? (
          <div className="diff-approval-new-notice">Новый файл — показано полное содержимое.</div>
        ) : null}
        {!isDelete && (
          <div className="diff-approval-diff-wrap">
            <DiffViewer oldContent={diff.before || ""} newContent={diff.after || ""} forceShowNew={isNew} />
          </div>
        )}
      </div>

      <div className="diff-approval-actions">
        <button className="diff-approval-btn diff-approval-reject" onClick={() => onDecide(false)}>
          <X size={14} /> Отклонить
        </button>
        <button className="diff-approval-btn diff-approval-approve" onClick={() => onDecide(true)}>
          <Check size={14} /> Применить
        </button>
      </div>
    </div>
  );
}
