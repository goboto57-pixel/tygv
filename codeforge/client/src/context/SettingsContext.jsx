import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";

const SettingsContext = createContext(null);

export const MODELS = [
  { id: "codestral-latest", label: "Codestral", provider: "Mistral", desc: "код и агентные задачи" },
  { id: "devstral-medium-latest", label: "Devstral Medium", provider: "Mistral", desc: "агентная разработка, сильный tool use" },
  { id: "mistral-large-latest", label: "Mistral Large", provider: "Mistral", desc: "сложные рассуждения" },
  { id: "mistral-medium-latest", label: "Mistral Medium", provider: "Mistral", desc: "баланс скорости и качества" },
  { id: "mistral-small-latest", label: "Mistral Small", provider: "Mistral", desc: "быстрые и простые задачи" },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "Google", desc: "лучший для coding и agentic workflows" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", provider: "Google", desc: "быстрый баланс качества и скорости" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "Google", desc: "стабильный Flash для обычных задач" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "Google", desc: "максимальная скорость для лёгких подзадач" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "Google", desc: "быстрый и экономичный Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "Google", desc: "сложное рассуждение и тяжёлый coding" }
];

export const MODES = [
  { id: "single", label: "Одна модель", desc: "выбранная модель ведёт задачу целиком" },
  {
    id: "council",
    label: "Совет (Gemini + Mistral)",
    desc: "Gemini и Mistral Large параллельно анализируют задачу и сообща договариваются о плане, затем Mistral Large выполняет"
  },
  {
    id: "collab",
    label: "Mistral Собрание",
    desc: "Mistral Large руководит и делегирует подзадачи субагентам Devstral"
  }
];

function loadSettings() {
  try {
    const raw = localStorage.getItem("cf_settings");
    if (raw) {
      const saved = { ...defaultSettings(), ...JSON.parse(raw) };
      const migrations = {
        "gemini-2.5-pro": "gemini-3.7-flash",
        "gemini-2.5-flash": "gemini-3.6-flash"
      };
      if (migrations[saved.model]) saved.model = migrations[saved.model];
      return saved;
    }
  } catch (e) {
    /* ignore */
  }
  return defaultSettings();
}
function defaultSettings() {
  return {
    theme: "dark",
    fontSize: "md",
    model: MODELS[0].id,
    sendOnEnter: true,
    mode: "single",
    requireApproval: false,
    planApproval: true,
    autoRollback: true
  };
}

export function SettingsProvider({ children }) {
  const [settings, setSettingsState] = useState(loadSettings);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.fontSize = settings.fontSize;
  }, [settings.theme, settings.fontSize]);

  const updateSettings = useCallback((patch) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem("cf_settings", JSON.stringify(next));
      } catch (e) {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    settings,
    updateSettings,
    MODELS,
    MODES,
  }), [settings, updateSettings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}