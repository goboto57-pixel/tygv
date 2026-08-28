import React from "react";

// Best-effort global capture for errors React's boundary can't see: anything
// thrown inside a promise (e.g. the SSE read loop in ChatContext.openStream)
// rejects silently as far as React is concerned — the UI just looks "frozen"
// or a later, unrelated render throws and gets blamed instead. Recording
// these separately makes it possible to tell "the SSE parser threw" apart
// from "a component crashed on bad data" after the fact.
if (typeof window !== "undefined" && !window.__codeforgeGlobalErrorHooked) {
  window.__codeforgeGlobalErrorHooked = true;
  const record = (entry) => {
    try {
      const key = "codeforge_error_log";
      const prev = JSON.parse(sessionStorage.getItem(key) || "[]");
      prev.push(entry);
      sessionStorage.setItem(key, JSON.stringify(prev.slice(-20)));
    } catch {}
    console.error("[CodeForge]", entry.kind, entry.message, entry);
  };
  window.addEventListener("error", (e) => {
    record({ kind: "window.onerror", message: e.message, stack: e.error?.stack || "", at: new Date().toISOString() });
  });
  window.addEventListener("unhandledrejection", (e) => {
    record({
      kind: "unhandledrejection",
      message: e.reason?.message || String(e.reason),
      stack: e.reason?.stack || "",
      at: new Date().toISOString()
    });
  });
}

export default class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    const entry = {
      kind: "react.componentDidCatch",
      message: error?.message || "Unknown UI error",
      stack: error?.stack || "",
      componentStack: info?.componentStack || "",
      at: new Date().toISOString()
    };
    // Log to console immediately so it's visible even if the tab is closed
    // before anyone thinks to check sessionStorage.
    console.error("[CodeForge] UI crashed:", entry);
    try {
      sessionStorage.setItem("codeforge_last_ui_error", JSON.stringify(entry));
      // Also fold into the rolling error log alongside async errors, so a
      // "Copy error" click captures the full sequence of events that led up
      // to the crash, not just the final render throw.
      const key = "codeforge_error_log";
      const prevLog = JSON.parse(sessionStorage.getItem(key) || "[]");
      prevLog.push(entry);
      sessionStorage.setItem(key, JSON.stringify(prevLog.slice(-20)));
    } catch {}
  }

  handleReload = () => window.location.reload();
  handleCopy = async () => {
    try {
      const log = sessionStorage.getItem("codeforge_error_log");
      const data = log || sessionStorage.getItem("codeforge_last_ui_error") || JSON.stringify({ message: this.state.error?.message, stack: this.state.error?.stack });
      await navigator.clipboard.writeText(data);
    } catch {}
  };
  handleClear = () => {
    try { localStorage.removeItem("codeforge_mobile_mode"); sessionStorage.removeItem("codeforge_last_ui_error"); sessionStorage.removeItem("codeforge_error_log"); } catch {}
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.state.error?.message || "Unknown error";
    const stack = this.state.error?.stack || "";
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#0a0b0d", color: "#ededf0", fontFamily: "Inter, sans-serif" }}>
        <section style={{ width: "min(640px, 100%)", border: "1px solid #2c2e33", borderRadius: 16, padding: 24, background: "#101113" }}>
          <h1 style={{ marginTop: 0 }}>CodeForge восстановление</h1>
          <p style={{ color: "#96979e", lineHeight: 1.6 }}>Интерфейс столкнулся с неожиданной ошибкой. История и файлы сохраняются отдельно, поэтому можно безопасно перезагрузить приложение.</p>
          <details style={{ margin: "12px 0", background: "#0a0b0d", border: "1px solid #2c2e33", borderRadius: 8, padding: 10 }}>
            <summary style={{ cursor: "pointer", color: "#ededf0" }}>{msg}</summary>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, color: "#9fb3c8", maxHeight: 260, overflow: "auto", marginTop: 8 }}>{stack.slice(0, 4000)}</pre>
          </details>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={this.handleReload} style={{ border: 0, borderRadius: 10, padding: "11px 16px", cursor: "pointer" }}>Перезагрузить</button>
            <button onClick={this.handleCopy} style={{ border: "1px solid #2c2e33", borderRadius: 10, padding: "11px 16px", cursor: "pointer", background: "transparent", color: "#ededf0" }}>Копировать ошибку</button>
            <button onClick={this.handleClear} style={{ border: "1px solid #2c2e33", borderRadius: 10, padding: "11px 16px", cursor: "pointer", background: "transparent", color: "#ededf0" }}>Сбросить настройки и перезагрузить</button>
          </div>
        </section>
      </main>
    );
  }
}
