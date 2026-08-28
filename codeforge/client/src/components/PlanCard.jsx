import React from "react";
import { motion } from "framer-motion";
import { ListChecks } from "lucide-react";

export default function PlanCard({ plan }) {
  if (!plan) return null;

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
      </div>
      <ol className="plan-steps">
        {(plan.steps || []).map((step, i) => (
          <li key={i} className="plan-step">
            <span className="plan-step-num">{i + 1}</span>
            <div className="plan-step-body">
              <div className="plan-step-title">{step.title}</div>
              {step.description && <div className="plan-step-desc">{step.description}</div>}
            </div>
          </li>
        ))}
      </ol>
    </motion.div>
  );
}
