import React, { useState } from "react";
import { motion } from "framer-motion";
import { ListChecks, Check, X, Loader2 } from "lucide-react";
import { useChat } from "../context/ChatContext.jsx";

export default function PlanCard({ plan }) {
  if (!plan) return null;
  const { resolvePlanApproval } = useChat();
  const [note, setNote] = useState("");
  const [decided, setDecided] = useState(false);

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const total = steps.length;
  const completed = Math.max(0, Math.min(total, plan.completedSteps || 0));
  const awaitingApproval = !!plan.token && !plan.approved && !plan.rejected && !decided;

  const approve = (approved) => {
    setDecided(true);
    resolvePlanApproval(plan.token, approved, note);
  };

  return (
    <motion.div
      className="plan-card"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="plan-card-header">
        <ListChecks size={15} />
        <span>{plan.title || "План выполнения"}</span>
        {total > 0 && (
          <span className="plan-progress-pill">
            {completed}/{total}
          </span>
        )}
      </div>

      {total > 0 && (
        <ol className="plan-steps">
          {steps.map((step, i) => {
            const done = i < completed;
            const active = i === completed && (plan.approved || plan.token == null) && completed < total && !plan.rejected;
            return (
              <li key={i} className={`plan-step ${done ? "done" : ""} ${active ? "active" : ""}`}>
                <span className="plan-step-num">
                  {done ? <Check size={12} /> : active ? <Loader2 size={12} className="spin" /> : i + 1}
                </span>
                <div className="plan-step-body">
                  <div className="plan-step-title">{step.title}</div>
                  {step.description && <div className="plan-step-desc">{step.description}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {plan.approved && (
        <div className="plan-decision plan-decision-ok">✓ План утверждён — выполняю</div>
      )}
      {plan.rejected && (
        <div className="plan-decision plan-decision-no">✕ План отклонён{plan.rejectedNote ? `: ${plan.rejectedNote}` : ""}</div>
      )}

      {awaitingApproval && (
        <div className="plan-approve-box">
          <div className="plan-approve-hint">Утвердите план, чтобы агент начал работу (кнопкой или напишите правку):</div>
          <textarea
            className="plan-approve-note"
            placeholder="Комментарий или правки к плану (необязательно)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <div className="plan-approve-actions">
            <button className="btn-approve" onClick={() => approve(true)}>✓ Утвердить</button>
            <button className="btn-reject" onClick={() => approve(false)}>✕ Отклонить</button>
          </div>
        </div>
      )}
    </motion.div>
  );
}
