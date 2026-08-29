import React from "react";
import { Timer, Cpu, Hourglass, Wrench } from "lucide-react";

/**
 * Rendered inline under an assistant message once that turn's `perf` event
 * has arrived (see ChatContext.jsx — stored per message as `m.perf`).
 * Answers "where did the time actually go" directly in the chat instead of
 * only in the server console: model generation, rate-limit backoff waits,
 * tool execution, or unaccounted overhead (network/server).
 */
function fmt(ms) {
  if (ms == null) return "0с";
  const s = ms / 1000;
  return s >= 10 ? `${Math.round(s)}с` : `${s.toFixed(1)}с`;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export default function PerfPanel({ perf }) {
  if (!perf || perf.totalMs == null) return null;
  const { totalMs, modelMs, modelCalls, rateLimitWaitMs, rateLimitHits, toolMs, toolCalls, otherMs } = perf;

  const rows = [
    { key: "model", icon: Cpu, label: "Генерация моделью", ms: modelMs, count: modelCalls, countLabel: "запрос" },
    { key: "rate_limit", icon: Hourglass, label: "Ожидание из-за лимита (429)", ms: rateLimitWaitMs, count: rateLimitHits, countLabel: "раз" },
    { key: "tools", icon: Wrench, label: "Выполнение инструментов", ms: toolMs, count: toolCalls, countLabel: "вызов" },
    { key: "other", icon: Timer, label: "Прочее (сеть/сервер)", ms: otherMs, count: null, countLabel: "" }
  ].filter((r) => r.ms > 0);

  const dominant = rows.reduce((a, b) => (b.ms > (a?.ms || 0) ? b : a), null);

  return (
    <div className="perf-panel">
      <div className="perf-panel-head">
        <Timer size={13} />
        <span>Куда ушло время — {fmt(totalMs)} всего</span>
      </div>

      <div className="perf-panel-bars">
        {rows.map((r) => (
          <div className="perf-panel-row" key={r.key}>
            <r.icon size={12} className="perf-panel-row-icon" />
            <span className="perf-panel-row-label">{r.label}</span>
            <div className="perf-panel-row-track">
              <div
                className={`perf-panel-row-fill${r.key === "rate_limit" ? " perf-panel-row-fill-warn" : ""}`}
                style={{ width: `${pct(r.ms, totalMs)}%` }}
              />
            </div>
            <span className="perf-panel-row-value">
              {fmt(r.ms)}{r.count ? ` · ${r.count} ${r.countLabel}` : ""}
            </span>
          </div>
        ))}
      </div>

      {dominant?.key === "rate_limit" && (
        <div className="perf-panel-hint">
          Большая часть времени ушла на паузы из-за лимита запросов (429) — увеличьте лимит/тариф API-ключа Mistral, это не связано со сложностью задачи.
        </div>
      )}
    </div>
  );
}
