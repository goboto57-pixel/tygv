import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sun, Moon, Check } from "lucide-react";
import { useApp } from "../context/AppContext.jsx";

export default function SettingsModal() {
  const { settingsOpen, setSettingsOpen, settings, updateSettings, MODELS } = useApp();

  return (
    <AnimatePresence>
      {settingsOpen && (
        <>
          <motion.div
            className="palette-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSettingsOpen(false)}
          />
          <motion.div
            className="settings-modal"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="settings-header">
              <h2>Настройки</h2>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>

            <div className="settings-body">
              <section className="settings-section">
                <h3>Модель</h3>
                <div className="settings-model-list">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`settings-model-item ${settings.model === m.id ? "active" : ""} ${m.disabled ? "disabled" : ""}`}
                      disabled={m.disabled}
                      onClick={() => updateSettings({ model: m.id })}
                    >
                      <div>
                        <div className="settings-model-name">
                          {m.label} <span className="settings-model-provider">{m.provider}</span>
                        </div>
                        <div className="settings-model-desc">{m.desc}</div>
                      </div>
                      {settings.model === m.id && <Check size={16} />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <h3>Тема</h3>
                <div className="settings-toggle-row">
                  <button
                    className={`settings-toggle-btn ${settings.theme === "dark" ? "active" : ""}`}
                    onClick={() => updateSettings({ theme: "dark" })}
                  >
                    <Moon size={15} /> Тёмная
                  </button>
                  <button
                    className={`settings-toggle-btn ${settings.theme === "light" ? "active" : ""}`}
                    onClick={() => updateSettings({ theme: "light" })}
                  >
                    <Sun size={15} /> Светлая
                  </button>
                </div>
              </section>

              <section className="settings-section">
                <h3>Размер шрифта</h3>
                <div className="settings-toggle-row">
                  {[
                    ["sm", "Мелкий"],
                    ["md", "Обычный"],
                    ["lg", "Крупный"]
                  ].map(([val, label]) => (
                    <button
                      key={val}
                      className={`settings-toggle-btn ${settings.fontSize === val ? "active" : ""}`}
                      onClick={() => updateSettings({ fontSize: val })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <h3>Отправка сообщения</h3>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.sendOnEnter}
                    onChange={(e) => updateSettings({ sendOnEnter: e.target.checked })}
                  />
                  <span>Enter отправляет, Shift+Enter — новая строка</span>
                </label>
              </section>

              <section className="settings-section settings-shortcuts">
                <h3>Горячие клавиши</h3>
                <div className="settings-shortcut-row">
                  <span>Палитра команд</span>
                  <kbd>Ctrl/Cmd + K</kbd>
                </div>
                <div className="settings-shortcut-row">
                  <span>Отправить сообщение</span>
                  <kbd>Enter</kbd>
                </div>
                <div className="settings-shortcut-row">
                  <span>Новая сессия</span>
                  <kbd>Ctrl/Cmd + N</kbd>
                </div>
              </section>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
