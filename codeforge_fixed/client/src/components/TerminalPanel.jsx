import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TerminalSquare, X, Trash2, ChevronDown } from "lucide-react";
import { useUI } from "../context/UIContext.jsx";

export default function TerminalPanel() {
  const { terminalLog, terminalOpen, setTerminalOpen, clearTerminal } = useUI();
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [terminalLog]);

  if (!terminalOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="terminal-panel"
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 220, opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="terminal-header">
          <div className="terminal-header-title">
            <TerminalSquare size={13} />
            <span>Терминал</span>
          </div>
          <div className="terminal-header-actions">
            <button className="icon-btn-sm" onClick={clearTerminal} title="Очистить">
              <Trash2 size={13} />
            </button>
            <button className="icon-btn-sm" onClick={() => setTerminalOpen(false)} title="Свернуть">
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
        <div className="terminal-body" ref={scrollRef}>
          {terminalLog.length === 0 && <div className="terminal-empty">Вывод команд появится здесь</div>}
          {terminalLog.map((entry) => (
            <div key={entry.id} className="terminal-entry">
              <div className="terminal-command">
                <span className="terminal-prompt">$</span> {entry.command}
              </div>
              <pre className="terminal-output">{entry.output}</pre>
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
