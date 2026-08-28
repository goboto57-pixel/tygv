import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Gauge, Clock } from "lucide-react";
import { useChat } from "../context/ChatContext.jsx";

export default function BudgetBar() {
  const { budgetWarning, isStreaming } = useChat();

  // Only worth showing while a turn is actually running — once streaming
  // ends the warning is stale context, not a live status.
  const visible = isStreaming && budgetWarning;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={`budget-bar budget-bar-${budgetWarning.level}`}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.16 }}
        >
          {budgetWarning.kind === "tokens" ? <Gauge size={13} /> : <Clock size={13} />}
          <span>
            {budgetWarning.kind === "tokens"
              ? `Задача расходует много токенов: ${budgetWarning.value.toLocaleString("ru")} / ${budgetWarning.limit.toLocaleString("ru")}`
              : `Задача выполняется долго: ${Math.round(budgetWarning.value / 1000)}с`}
          </span>
          {budgetWarning.level === "hard" && <span className="budget-bar-hard-tag">превышен лимит</span>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
