import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, Info } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

const ICONS = { success: CheckCircle2, error: XCircle, info: Info };

export default function Toast() {
  const { toast, setToast } = useApp();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  const Icon = toast ? ICONS[toast.kind] || Info : Info;

  return (
    <AnimatePresence>
      {toast && (
        <motion.div
          className={`toast toast-${toast.kind}`}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          key={toast.id}
        >
          <Icon size={16} />
          <span>{toast.text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
