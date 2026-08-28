import React, { useMemo } from "react";
import { lineDiff, diffStats } from "../utils/lineDiff.js";

export default function DiffViewer({ oldContent, newContent }) {
  const diff = useMemo(() => lineDiff(oldContent || "", newContent || ""), [oldContent, newContent]);
  const { added, removed } = useMemo(() => diffStats(diff), [diff]);

  if (!oldContent) {
    return null; // new file, nothing to diff against
  }

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-stats">
        <span className="diff-stat-added">+{added}</span>
        <span className="diff-stat-removed">-{removed}</span>
      </div>
      <div className="diff-viewer-body">
        {diff.map((d, idx) => (
          <div key={idx} className={`diff-line diff-line-${d.type}`}>
            <span className="diff-line-marker">{d.type === "add" ? "+" : d.type === "remove" ? "-" : " "}</span>
            <span className="diff-line-text">{d.line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
