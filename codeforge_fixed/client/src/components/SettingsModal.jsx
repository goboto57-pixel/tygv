import React, { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Sun, Moon, Check } from "lucide-react";
import { useSettings } from "../context/SettingsContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import ThemeCustomizer from "./ThemeCustomizer.jsx";

export default function SettingsModal() {
  const { settings, updateSettings, MODELS, MODES } = useSettings();
  const { settingsOpen, setSettingsOpen } = useUI();
  const modalRef = useRef(null);
  const previousActiveElement = useRef(null);

  useEffect(() => {
    if (settingsOpen) {
      previousActiveElement.current = document.activeElement;
      modalRef.current?.focus();
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
      previousActiveElement.current?.focus();
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [settingsOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!settingsOpen) return;
      if (e.key === "Escape") {
        setSettingsOpen(false);
      }
      if (e.key === "Tab") {
        const focusableElements = modalRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements?.[0];
        const lastElement = focusableElements?.[focusableElements.length - 1];
        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen, setSettingsOpen]);

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
            aria-hidden="true"
          />
          <div className="settings-modal-wrap">
          <motion.div
            ref={modalRef}
            className="settings-modal"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            tabIndex={-1}
          >
            <div className="settings-header">
              <h2 id="settings-title">Настройки</h2>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Закрыть настройки">
                <X size={18} />
              </button>
            </div>

            <div className="settings-body">
              <section className="settings-section" aria-labelledby="model-heading">
                <h3 id="model-heading">Модель</h3>
                <div className="settings-model-list" role="radiogroup" aria-label="Выбор модели">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`settings-model-item ${settings.model === m.id ? "active" : ""} ${m.disabled ? "disabled" : ""}`}
                      disabled={m.disabled}
                      onClick={() => updateSettings({ model: m.id })}
                      role="radio"
                      aria-checked={settings.model === m.id}
                      aria-disabled={m.disabled}
                    >
                      <div>
                        <div className="settings-model-name">
                          {m.label} <span className="settings-model-provider">{m.provider}</span>
                        </div>
                        <div className="settings-model-desc">{m.desc}</div>
                      </div>
                      {settings.model === m.id && <Check size={16} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-section" aria-labelledby="mode-heading">
                <h3 id="mode-heading">Режим</h3>
                <div className="settings-model-list" role="radiogroup" aria-label="Выбор режима работы">
                  {MODES.map((md) => (
                    <button
                      key={md.id}
                      className={`settings-model-item ${settings.mode === md.id ? "active" : ""}`}
                      onClick={() => updateSettings({ mode: md.id })}
                      role="radio"
                      aria-checked={settings.mode === md.id}
                    >
                      <div>
                        <div className="settings-model-name">{md.label}</div>
                        <div className="settings-model-desc">{md.desc}</div>
                      </div>
                      {settings.mode === md.id && <Check size={16} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </section>

              <section className="settings-section" aria-labelledby="theme-heading">
                <h3 id="theme-heading">Тема</h3>
                <div className="settings-toggle-row" role="radiogroup" aria-label="Выбор темы">
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
                <h3>Тема и акцент</h3>
                <ThemeCustomizer />
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

              <section className="settings-section">
                <h3>Безопасность агента</h3>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={!!settings.requireApproval}
                    onChange={(e) => updateSettings({ requireApproval: e.target.checked })}
                  />
                  <span>Подтверждать каждое изменение файла перед применением (diff-review)</span>
                </label>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={!!settings.planApproval}
                    onChange={(e) => updateSettings({ planApproval: e.target.checked })}
                  />
                  <span>Показывать план и ждать утверждения перед началом работы (кнопкой или текстом)</span>
                </label>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.autoRollback !== false}
                    onChange={(e) => updateSettings({ autoRollback: e.target.checked })}
                  />
                  <span>Автоматически откатывать изменения хода, если тесты остались проваленными</span>
                </label>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={!!settings.budgetPause}
                    onChange={(e) => updateSettings({ budgetPause: e.target.checked })}
                  />
                  <span>Ставить задачу на паузу при превышении лимита токенов/времени (вместо жёсткой остановки)</span>
                </label>
                <label className="settings-checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.circuitBreaker !== false}
                    onChange={(e) => updateSettings({ circuitBreaker: e.target.checked })}
                  />
                  <span>Автоматический предохранитель: пропускать совет при повторных сбоях</span>
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
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
