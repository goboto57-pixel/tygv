import React from "react";
import { motion } from "framer-motion";
import { Globe, Server, Terminal, FileCode2 } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

const TEMPLATES = [
  { icon: Globe, label: "React-приложение", prompt: "Создай новое React-приложение на Vite с чистой стартовой структурой." },
  { icon: Server, label: "Node.js API", prompt: "Создай REST API на Express с базовой структурой роутов и middleware." },
  { icon: Terminal, label: "Python-скрипт", prompt: "Напиши Python-скрипт для обработки CSV-файлов с аргументами командной строки." },
  { icon: FileCode2, label: "Рефакторинг", prompt: "Проанализируй загруженные файлы и предложи план рефакторинга." }
];

export default function EmptyState() {
  const { sendMessage } = useApp();

  return (
    <div className="empty-state">
      <motion.div
        className="empty-wordmark"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        aria-hidden="true"
      >
        codeforge
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
      >
        Что будем строить?
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.13, ease: [0.16, 1, 0.3, 1] }}
        className="empty-sub"
      >
        Опишите задачу — агент составит план, покажет ход рассуждений и вернёт готовые файлы.
      </motion.p>

      <motion.div
        className="template-grid"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        {TEMPLATES.map((t, i) => (
          <button key={i} className="template-card" onClick={() => sendMessage(t.prompt)}>
            <t.icon size={17} strokeWidth={1.8} />
            <span>{t.label}</span>
          </button>
        ))}
      </motion.div>
    </div>
  );
}
