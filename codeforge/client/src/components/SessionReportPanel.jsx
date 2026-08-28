import React from "react";
import { BarChart3, FileCode2, FlaskConical, AlertTriangle, RotateCcw, CheckCircle2 } from "lucide-react";

/**
 * Rendered inline under an assistant message once that turn's
 * `session_report` event has arrived (see AppContext.jsx — stored per
 * message as `m.sessionReport`). Deliberately compact: a handful of
 * numbers, not a dashboard, since it renders once per turn in the chat
 * stream rather than in a dedicated panel.
 */
export default function SessionReportPanel({ report }) {
  if (!report?.metrics) return null;
  const { metrics, rolledBack } = report;

  return (
    <div className="session-report">
      <div className="session-report-head">
        <BarChart3 size={13} />
        <span>Отчёт по сессии</span>
        {rolledBack && (
          <span className="session-report-rollback-tag">
            <RotateCcw size={11} /> изменения откачены
          </span>
        )}
      </div>

      <div className="session-report-grid">
        <div className="session-report-stat">
          <FileCode2 size={13} />
          <div>
            <div className="session-report-stat-value">{metrics.filesChangedThisTurn}</div>
            <div className="session-report-stat-label">файлов изменено</div>
          </div>
        </div>

        <div className="session-report-stat">
          <FileCode2 size={13} />
          <div>
            <div className="session-report-stat-value">{metrics.codeFilesTotal}</div>
            <div className="session-report-stat-label">файлов кода всего</div>
          </div>
        </div>

        <div className="session-report-stat">
          <FlaskConical size={13} />
          <div>
            <div className="session-report-stat-value">
              {metrics.hasTestCoverage ? metrics.testFilesTotal : "0"}
            </div>
            <div className="session-report-stat-label">тестовых файлов</div>
          </div>
        </div>

        <div className="session-report-stat">
          {metrics.lintIssues.length === 0 ? (
            <CheckCircle2 size={13} className="session-report-icon-ok" />
          ) : (
            <AlertTriangle size={13} className="session-report-icon-warn" />
          )}
          <div>
            <div className="session-report-stat-value">{metrics.lintIssues.length}</div>
            <div className="session-report-stat-label">файлов с замечаниями</div>
          </div>
        </div>
      </div>

      {metrics.testSummary?.ranAny && (
        <div className={`session-report-tests ${metrics.testSummary.allPassed ? "ok" : "fail"}`}>
          {metrics.testSummary.allPassed ? "Тесты проходят" : "Есть проваленные тесты"}
          {metrics.testSummary.lastTotal != null && (
            <span> — {metrics.testSummary.lastPassed}/{metrics.testSummary.lastTotal}</span>
          )}
        </div>
      )}

      {metrics.lintIssues.length > 0 && (
        <ul className="session-report-lint-list">
          {metrics.lintIssues.slice(0, 5).map((li) => (
            <li key={li.path}>
              <code>{li.path}</code>
              <span> — {li.issues.length} замечани{li.issues.length === 1 ? "е" : "я"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
