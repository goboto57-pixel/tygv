import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Menu, Gauge, Camera, Download, Search, Settings, PanelLeft, PanelRight, Focus, BarChart3, Bookmark, Smartphone, Rocket, Check, ExternalLink, MoreHorizontal, History, RefreshCw, AlertCircle, Trash2 } from "lucide-react";
import { useChat } from "../context/ChatContext.jsx";
import { useFiles } from "../context/FilesContext.jsx";
import { useSessions } from "../context/SessionsContext.jsx";
import { useUI } from "../context/UIContext.jsx";
import { useSettings } from "../context/SettingsContext.jsx";
import SnapshotsMenu from "./SnapshotsMenu.jsx";
import StatsDashboard from "./StatsDashboard.jsx";
import MemoryModal from "./MemoryModal.jsx";
import { exportZip } from "../utils/exportZip.js";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// How long to keep polling a fresh deploy for "ready" before giving up and
// just trusting the URL is fine — Netlify usually finishes in a few seconds
// for a small static site, this is a generous ceiling for slower ones.
const DEPLOY_POLL_MAX_MS = 45_000;
const DEPLOY_POLL_INTERVAL_MS = 2_000;

export default function TopBar({ onMenuClick, onFilesClick, leftSidebarOpen, rightPanelOpen, isMobile }) {
  const { usage, isStreaming } = useChat();
  const { files, chatId } = useFiles();
  const { takeSnapshot } = useSessions();
  const { setCommandPaletteOpen, setSettingsOpen, focusMode, setFocusMode, mobileMode, setMobileMode, notify } = useUI();
  const { settings, MODELS } = useSettings();
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [deployMenuOpen, setDeployMenuOpen] = useState(false);
  // idle | zipping | processing | done | error
  const [deployState, setDeployState] = useState("idle");
  const [deployUrl, setDeployUrl] = useState(null);
  const [deployHistory, setDeployHistory] = useState([]);
  const pollRef = useRef(null);
  const moreRef = useRef(null);
  const deployRef = useRef(null);

  // Load any previously-published URL for this chat on mount/chat switch so
  // the rocket button reflects reality after a reload, not just this session.
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    fetch(`${API_BASE}/projects/deploy/${encodeURIComponent(chatId)}/history`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.deploy?.url) { setDeployUrl(data.deploy.url); setDeployState("done"); }
        setDeployHistory(data.history || []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [chatId]);

  useEffect(() => () => clearTimeout(pollRef.current), []);

  // Close dropdowns on outside click.
  useEffect(() => {
    const onClick = (e) => {
      if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false);
      if (deployRef.current && !deployRef.current.contains(e.target)) setDeployMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const pollDeployStatus = useCallback((deployId, url, startedAt) => {
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      if (Date.now() - startedAt > DEPLOY_POLL_MAX_MS) {
        // Give up waiting — the deploy is very likely fine, Netlify just
        // hasn't confirmed "ready" yet. Show it as live rather than stuck.
        setDeployState("done");
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/projects/deploy/${deployId}/status`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "status check failed");
        if (data.state === "ready") {
          setDeployState("done");
          notify(`Сайт опубликован: ${data.url || url}`, "success");
        } else if (data.state === "error") {
          setDeployState("error");
          notify("Netlify сообщил об ошибке сборки при публикации", "error");
        } else {
          pollDeployStatus(deployId, url, startedAt);
        }
      } catch {
        // Transient network hiccup — don't fail the whole publish over one
        // missed poll, just keep trying until the ceiling above.
        pollDeployStatus(deployId, url, startedAt);
      }
    }, DEPLOY_POLL_INTERVAL_MS);
  }, [notify]);

  const handleDeploy = async () => {
    if (deployState === "zipping" || deployState === "processing" || files.length === 0) return;
    setDeployState("zipping");
    setDeployMenuOpen(false);
    // Snapshot right before publishing — if the published version turns out
    // broken, the user has a one-click restore point from just before it
    // went live, without having to remember to take one themselves.
    try { await takeSnapshot(`Перед публикацией · ${new Date().toLocaleTimeString("ru-RU")}`, files); } catch {}
    try {
      const res = await fetch(`${API_BASE}/projects/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, files, projectName: chatId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Не удалось опубликовать сайт");
      setDeployUrl(data.url);
      setDeployHistory((prev) => [{ url: data.url, siteId: data.siteId, deployId: data.deployId, deployedAt: new Date().toISOString(), fileCount: files.length }, ...prev].slice(0, 20));
      try { await navigator.clipboard.writeText(data.url); } catch {}
      if (data.deployId) {
        setDeployState("processing");
        notify("Публикуется… ссылка уже скопирована", "info");
        pollDeployStatus(data.deployId, data.url, Date.now());
      } else {
        setDeployState("done");
        notify(`Сайт опубликован: ${data.url}`, "success");
      }
    } catch (err) {
      setDeployState("error");
      notify(err.message || "Ошибка публикации", "error");
      setTimeout(() => setDeployState(deployUrl ? "done" : "idle"), 4000);
    }
  };

  const handleUnpublish = async () => {
    if (!chatId || !deployUrl) return;
    if (!window.confirm("Снять сайт с публикации? Ссылка перестанет работать.")) return;
    try {
      const res = await fetch(`${API_BASE}/projects/deploy/${encodeURIComponent(chatId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Не удалось снять сайт с публикации");
      setDeployUrl(null);
      setDeployState("idle");
      setDeployMenuOpen(false);
      notify("Сайт снят с публикации", "info");
    } catch (err) {
      notify(err.message || "Ошибка при снятии с публикации", "error");
    }
  };

  const toggleMobileMode = () => {
    const next = !mobileMode;
    setMobileMode(next);
    try { localStorage.setItem("codeforge_mobile_mode", next ? "1" : "0"); } catch {}
  };

  const totalTokens = usage.prompt_tokens + usage.completion_tokens;
  const estCost = useMemo(
    () => ((usage.prompt_tokens / 1_000_000) * 0.3 + (usage.completion_tokens / 1_000_000) * 0.9).toFixed(4),
    [usage.prompt_tokens, usage.completion_tokens]
  );
  const activeModel = useMemo(() => MODELS.find((m) => m.id === settings.model), [MODELS, settings.model]);

  const deployIcon =
    deployState === "zipping" || deployState === "processing" ? <span className="spinner-tiny" aria-hidden="true" /> :
    deployState === "done" ? <Check size={17} /> :
    deployState === "error" ? <AlertCircle size={17} /> :
    <Rocket size={17} />;
  const deployTitle =
    deployState === "zipping" ? "Собираю проект…" :
    deployState === "processing" ? "Netlify обрабатывает деплой…" :
    deployState === "error" ? "Ошибка публикации — нажмите, чтобы повторить" :
    deployUrl ? `Опубликовано: ${deployUrl} (нажмите ▾ для истории)` : "Опубликовать сайт онлайн";

  return (
    <header className="topbar" role="banner">
      <button
        className={`icon-btn ${leftSidebarOpen ? "icon-btn-active" : ""}`}
        onClick={onMenuClick}
        title="История чатов (Ctrl/Cmd+B)"
        aria-label={leftSidebarOpen ? "Закрыть меню" : "Открыть меню"}
        aria-expanded={leftSidebarOpen}
        aria-controls="sidebar"
      >
        {isMobile ? <Menu size={20} /> : <PanelLeft size={17} />}
      </button>

      <div className={`topbar-status ${isStreaming ? "streaming" : ""}`} role="status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <span className="topbar-status-text">{isStreaming ? "Агент работает…" : "Агент готов"}</span>
        {!isMobile && activeModel && <span className="topbar-model-chip">{activeModel.label}</span>}
      </div>

      <div className="topbar-actions" role="group" aria-label="Toolbar actions">
        <div className="usage-pill" role="status" aria-label={`Промпт ${usage.prompt_tokens.toLocaleString("ru-RU")} + ответ ${usage.completion_tokens.toLocaleString("ru-RU")} = ${totalTokens.toLocaleString("ru-RU")} токенов, ~$${estCost}`} title={`Промпт: ${usage.prompt_tokens.toLocaleString("ru-RU")} · Ответ: ${usage.completion_tokens.toLocaleString("ru-RU")} · Всего: ${totalTokens.toLocaleString("ru-RU")} · ~$${estCost}`}>
          <Gauge size={13} aria-hidden="true" />
          <span>{totalTokens.toLocaleString("ru-RU")}</span>
          <span className="usage-cost">${estCost}</span>
        </div>

        <div className="deploy-btn-group" ref={deployRef}>
          <button
            className={`icon-btn ${deployState === "done" ? "icon-btn-active" : ""} ${deployState === "error" ? "icon-btn-danger" : ""}`}
            onClick={handleDeploy}
            disabled={files.length === 0 || deployState === "zipping" || deployState === "processing"}
            aria-disabled={files.length === 0 || deployState === "zipping" || deployState === "processing"}
            title={deployTitle}
            aria-label="Опубликовать сайт"
          >
            {deployIcon}
          </button>
          {(deployUrl || deployHistory.length > 0) && (
            <button
              className="icon-btn deploy-caret"
              onClick={() => setDeployMenuOpen((v) => !v)}
              title="История публикаций"
              aria-label="История публикаций"
              aria-expanded={deployMenuOpen}
            >
              <History size={13} />
            </button>
          )}
          {deployMenuOpen && (
            <div className="deploy-history-menu" role="menu">
              <div className="deploy-history-head">Публикации</div>
              {deployHistory.length === 0 && <div className="deploy-history-empty">Пока не публиковали</div>}
              {deployUrl && (
                <div className="deploy-qr-wrap">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(deployUrl)}`}
                    alt="QR-код опубликованного сайта"
                    width={96}
                    height={96}
                    loading="lazy"
                  />
                  <span>Отсканируйте, чтобы открыть на телефоне</span>
                </div>
              )}
              {deployHistory.map((d, i) => (
                <a key={d.deployId || i} href={d.url} target="_blank" rel="noopener noreferrer" className="deploy-history-item">
                  <ExternalLink size={12} />
                  <span className="deploy-history-url">{d.url.replace(/^https?:\/\//, "")}</span>
                  <span className="deploy-history-time">{new Date(d.deployedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </a>
              ))}
              <button className="deploy-history-redeploy" onClick={handleDeploy} disabled={deployState === "zipping" || deployState === "processing"}>
                <RefreshCw size={12} /> Опубликовать текущую версию
              </button>
              {deployUrl && (
                <button className="deploy-history-unpublish" onClick={handleUnpublish}>
                  <Trash2 size={12} /> Снять с публикации
                </button>
              )}
            </div>
          )}
        </div>
        {deployUrl && (deployState === "done" || deployState === "processing") && !isMobile && (
          <a
            href={deployUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="deploy-url-chip"
            title="Открыть опубликованный сайт"
          >
            <ExternalLink size={12} />
            <span>{deployUrl.replace(/^https?:\/\//, "")}</span>
          </a>
        )}

        <button
          className={`icon-btn ${rightPanelOpen ? "icon-btn-active" : ""}`}
          onClick={onFilesClick}
          title="Панель файлов (Ctrl/Cmd+J)"
          aria-label={rightPanelOpen ? "Закрыть панель файлов" : "Открыть панель файлов"}
          aria-expanded={rightPanelOpen}
          aria-controls="files-panel"
        >
          <PanelRight size={17} />
          {!rightPanelOpen && files.length > 0 && <span className="file-count icon-btn-badge" aria-label={`${files.length} открытых файлов`}>{files.length}</span>}
        </button>

        {/* Secondary actions collapse into a single "Ещё" menu on desktop to
            keep the toolbar from growing every time a feature is added; on
            mobile they were already hidden/relocated, so keep them inline
            there since .topbar-actions already scrolls horizontally. */}
        {isMobile ? (
          <>
            <button className={`icon-btn ${mobileMode ? "icon-btn-active" : ""}`} onClick={toggleMobileMode} title="Мобильный режим" aria-label="Мобильный режим">
              <Smartphone size={17} />
            </button>
            <button className="icon-btn" onClick={() => takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`, files)} title="Сохранить снимок версии" disabled={files.length === 0} aria-label="Сохранить снимок версии">
              <Camera size={17} />
            </button>
            <button className="icon-btn" onClick={() => exportZip(files, `codeforge-${(chatId || "project").slice(0, 8)}`)} title="Скачать проект (.zip)" disabled={files.length === 0} aria-label="Скачать проект как ZIP">
              <Download size={17} />
            </button>
            <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Настройки" aria-label="Настройки">
              <Settings size={17} />
            </button>
          </>
        ) : (
          <div className="more-menu-wrap" ref={moreRef}>
            <button className={`icon-btn ${moreOpen ? "icon-btn-active" : ""}`} onClick={() => setMoreOpen((v) => !v)} title="Ещё" aria-label="Дополнительные действия" aria-expanded={moreOpen}>
              <MoreHorizontal size={17} />
            </button>
            {moreOpen && (
              <div className="more-menu" role="menu">
                <button role="menuitem" onClick={() => { setCommandPaletteOpen(true); setMoreOpen(false); }}><Search size={15} /> Команды <kbd>⌘K</kbd></button>
                <button role="menuitem" onClick={() => { takeSnapshot(`Снимок ${new Date().toLocaleTimeString("ru-RU")}`, files); setMoreOpen(false); }} disabled={files.length === 0}><Camera size={15} /> Снимок версии</button>
                <button role="menuitem" onClick={() => { exportZip(files, `codeforge-${(chatId || "project").slice(0, 8)}`); setMoreOpen(false); }} disabled={files.length === 0}><Download size={15} /> Скачать .zip</button>
                <button role="menuitem" onClick={() => { setFocusMode(!focusMode); document.querySelector(".shell")?.classList.toggle("focus-mode", !focusMode); setMoreOpen(false); }}><Focus size={15} /> {focusMode ? "Выйти из фокус-режима" : "Фокус-режим"}</button>
                <button role="menuitem" onClick={() => { setStatsOpen((v) => !v); setMoreOpen(false); }}><BarChart3 size={15} /> Статистика</button>
                <button role="menuitem" onClick={() => { setMemoryOpen(true); setMoreOpen(false); }}><Bookmark size={15} /> Память проекта</button>
                <button role="menuitem" onClick={() => { toggleMobileMode(); setMoreOpen(false); }}><Smartphone size={15} /> Мобильный режим {mobileMode ? "(вкл)" : ""}</button>
                <div className="more-menu-sep" />
                <button role="menuitem" onClick={() => { setSettingsOpen(true); setMoreOpen(false); }}><Settings size={15} /> Настройки</button>
              </div>
            )}
          </div>
        )}
      </div>

      {snapshotsOpen && <SnapshotsMenu onClose={() => setSnapshotsOpen(false)} />}
      {memoryOpen && <MemoryModal open={memoryOpen} onClose={() => setMemoryOpen(false)} />}
      {statsOpen && (
        <div style={{ position: "absolute", top: "52px", right: "12px", width: "min(360px, 92vw)", background: "var(--bg-2)", border: "1px solid var(--border-strong)", borderRadius: "12px", padding: "12px", zIndex: 50, boxShadow: "var(--shadow-lg)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontSize: "13px" }}>Статистика</strong>
            <button className="icon-btn" onClick={()=>setStatsOpen(false)}>×</button>
          </div>
          <StatsDashboard />
        </div>
      )}
    </header>
  );
}
