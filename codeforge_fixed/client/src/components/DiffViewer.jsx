import React, { useMemo } from "react";
import { lineDiff, diffStats } from "../utils/lineDiff.js";

export default function DiffViewer({ oldContent, newContent, forceShowNew }) {
  const diff = useMemo(() => lineDiff(oldContent || "", newContent || ""), [oldContent, newContent]);
  const { added, removed } = useMemo(() => diffStats(diff), [diff]);

  // Historically this bailed out entirely for a brand-new file (no
  // oldContent to diff against) since there was nothing meaningful to show
  // in the inline code-viewer's diff toggle. The approval modal needs the
  // opposite behavior — a new file is exactly the case it most needs to
  // show something for — so it opts in via forceShowNew and gets the full
  // content rendered as all-added lines instead of a blank panel.
  if (!oldContent && !forceShowNew) {
    return null;
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
