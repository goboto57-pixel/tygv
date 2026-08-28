import React, { useState, useEffect } from "react";
import { Palette, Check } from "lucide-react";
import { useSettings } from "../context/SettingsContext.jsx";

const PRESETS = [
  { id: "dark", label: "Графит", bg: "#0a0b0d", accent: "#e8e9ec" },
  { id: "light", label: "Светлый", bg: "#f6f7f9", accent: "#1a1d24" },
  { id: "ocean", label: "Океан", bg: "#0a141e", accent: "#38bdf8" },
  { id: "forest", label: "Лес", bg: "#0a1410", accent: "#22c55e" },
  { id: "sunset", label: "Закат", bg: "#1a0f0a", accent: "#f59e0b" },
  { id: "neon", label: "Неон", bg: "#0f0a1a", accent: "#a855f7" },
];

export default function ThemeCustomizer() {
  const { settings, updateSettings } = useSettings();
  const [customAccent, setCustomAccent] = useState(settings.accentColor || "#e8e9ec");

  useEffect(() => {
    if (customAccent) {
      document.documentElement.style.setProperty("--accent", customAccent);
      updateSettings({ accentColor: customAccent });
    }
  }, [customAccent]);

  const applyPreset = (preset) => {
    updateSettings({ theme: preset.id === "light" ? "light" : "dark" });
    document.documentElement.setAttribute("data-theme", preset.id === "light" ? "light" : "dark");
    if (preset.accent) {
      setCustomAccent(preset.accent);
      document.documentElement.style.setProperty("--accent", preset.accent);
    }
    if (preset.bg) {
      document.documentElement.style.setProperty("--bg-0", preset.bg);
    }
  };

  return (
    <div className="theme-customizer">
      <h4 style={{ fontSize: "12px", fontWeight: 600, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 6 }}><Palette size={14}/> Темы</h4>
      <div className="theme-presets">
        {PRESETS.map(p => (
          <button key={p.id} className={`theme-preset ${settings.theme === p.id ? "active" : ""}`} style={{ background: p.bg, borderColor: p.accent }} onClick={() => applyPreset(p)} title={p.label} />
        ))}
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <input type="color" value={customAccent} onChange={e => setCustomAccent(e.target.value)} style={{ width: 32, height: 32, border: "none", borderRadius: 6, cursor: "pointer" }} />
        <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Акцент {customAccent}</span>
        {settings.accentColor === customAccent && <Check size={12} style={{ color: "var(--accent-success)" }} />}
      </div>
    </div>
  );
}
