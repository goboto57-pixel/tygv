import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from "react";

const SettingsContext = createContext(null);

export const MODELS = [
  // --- Mistral: основные ---
  { id: "mistral-medium-latest", label: "Mistral Medium", provider: "Mistral", group: "Mistral", desc: "модель по умолчанию в консоли Mistral — баланс скорости/качества, хороша для сайтов и приложений", vision: true },
  { id: "mistral-large-latest", label: "Mistral Large", provider: "Mistral", group: "Mistral", desc: "флагман для сложных рассуждений и архитектуры, медленнее Medium", vision: true },
  { id: "mistral-small-latest", label: "Mistral Small", provider: "Mistral", group: "Mistral", desc: "Small 4: reasoning + vision + агентный код в одной модели, поддерживает эффорт", vision: true, reasoning: true },
  // --- Mistral: код ---
  { id: "codestral-latest", label: "Codestral", provider: "Mistral", group: "Mistral · код", desc: "автодополнение и генерация кода — хуже следует инструкциям по дизайну целого сайта" },
  { id: "devstral-medium-latest", label: "Devstral Medium", provider: "Mistral", group: "Mistral · код", desc: "агентная разработка, сильный tool use" },
  { id: "devstral-2512", label: "Devstral 2", provider: "Mistral", group: "Mistral · код", desc: "новое поколение агентных кодинг-моделей" },
  // --- Mistral: зрение ---
  { id: "pixtral-large-latest", label: "Pixtral Large", provider: "Mistral", group: "Mistral · зрение", desc: "работа с изображениями/референсами дизайна", vision: true },
  // --- Mistral: рассуждения ---
  { id: "magistral-medium-latest", label: "Magistral Medium", provider: "Mistral", group: "Mistral · рассуждения", desc: "глубокое пошаговое рассуждение (chain-of-thought), поддерживает эффорт", reasoning: true },
  { id: "magistral-small-latest", label: "Magistral Small", provider: "Mistral", group: "Mistral · рассуждения", desc: "компактная reasoning-модель дешевле Medium", vision: true, reasoning: true },
  // --- Mistral: лёгкие ---
  { id: "ministral-14b-latest", label: "Ministral 14B", provider: "Mistral", group: "Mistral · лёгкие", desc: "быстрые простые задачи, хорошая цена/качество" },
  { id: "ministral-8b-latest", label: "Ministral 8B", provider: "Mistral", group: "Mistral · лёгкие", desc: "компактная модель для лёгких подзадач" },
  { id: "ministral-3b-latest", label: "Ministral 3B", provider: "Mistral", group: "Mistral · лёгкие", desc: "самая быстрая модель линейки, для простейших правок" },
  { id: "labs-leanstral-1-5-1", label: "Leanstral 1.5.1", provider: "Mistral", group: "Mistral · экспериментальные", desc: "модель из Mistral Labs, может быть нестабильна" },
  // --- Gemini ---
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", provider: "Google", group: "Gemini", desc: "лучший для coding и agentic workflows" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", provider: "Google", group: "Gemini", desc: "быстрый баланс качества и скорости" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "Google", group: "Gemini", desc: "стабильный Flash для обычных задач" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "Google", group: "Gemini", desc: "максимальная скорость для лёгких подзадач" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "Google", group: "Gemini", desc: "быстрый и экономичный Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", provider: "Google", group: "Gemini", desc: "сложное рассуждение и тяжёлый coding" }
];

// Режимы работы модели — те же, что "Code / Search / Premium Search / Image"
// в плейграунде console.mistral.ai. "code" — обычный агентный цикл с
// файловыми инструментами (по умолчанию, это и есть "код").
export const TOOL_MODES = [
  { id: "code", label: "Код", desc: "агент читает/пишет файлы проекта (по умолчанию)" },
  { id: "web_search", label: "Поиск", desc: "поиск в интернете с источниками (без изменения файлов)" },
  { id: "web_search_premium", label: "Premium Поиск", desc: "расширенный поиск с более высоким лимитом" },
  { id: "image", label: "Изображение", desc: "генерация изображений (Black Forest Labs FLUX)" }
];

export const REASONING_EFFORTS = [
  { id: "none", label: "Без эффорта", desc: "быстрый ответ без явного рассуждения" },
  { id: "low", label: "Низкий" },
  { id: "medium", label: "Средний" },
  { id: "high", label: "Высокий", desc: "глубокое рассуждение — медленнее, но точнее (только модели с reasoning)" }
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
    toolMode: "code",
    reasoningEffort: "none",
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
    TOOL_MODES,
    REASONING_EFFORTS,
  }), [settings, updateSettings]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}