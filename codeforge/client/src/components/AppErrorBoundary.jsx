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

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#0a0b0d", color: "#ededf0", fontFamily: "Inter, sans-serif" }}>
        <section style={{ width: "min(560px, 100%)", border: "1px solid #2c2e33", borderRadius: 16, padding: 24, background: "#101113" }}>
          <h1 style={{ marginTop: 0 }}>CodeForge восстановление</h1>
          <p style={{ color: "#96979e", lineHeight: 1.6 }}>Интерфейс столкнулся с неожиданной ошибкой. История и файлы сохраняются отдельно, поэтому можно безопасно перезагрузить приложение.</p>
          <button onClick={this.handleReload} style={{ border: 0, borderRadius: 10, padding: "11px 16px", cursor: "pointer" }}>Перезагрузить</button>
        </section>
      </main>
    );
  }
}
