import React from "react";

export default class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    try {
      sessionStorage.setItem("codeforge_last_ui_error", JSON.stringify({
        message: error?.message || "Unknown UI error",
        stack: error?.stack || "",
        componentStack: info?.componentStack || "",
        at: new Date().toISOString()
      }));
    } catch {}
  }

  handleReload = () => window.location.reload();
  handleCopy = async () => {
    try {
      const data = sessionStorage.getItem("codeforge_last_ui_error") || JSON.stringify({ message: this.state.error?.message, stack: this.state.error?.stack });
      await navigator.clipboard.writeText(data);
    } catch {}
  };
  handleClear = () => {
    try { localStorage.removeItem("codeforge_mobile_mode"); sessionStorage.removeItem("codeforge_last_ui_error"); } catch {}
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
