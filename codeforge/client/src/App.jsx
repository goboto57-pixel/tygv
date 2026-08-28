import React, { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { X } from "lucide-react";
import { ChatProvider, useChat } from "./context/ChatContext.jsx";
import { FilesProvider, useFiles } from "./context/FilesContext.jsx";
import { SessionsProvider, useSessions } from "./context/SessionsContext.jsx";
import { UIProvider, useUI } from "./context/UIContext.jsx";
import { SettingsProvider, useSettings } from "./context/SettingsContext.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import TopBar from "./components/TopBar.jsx";
import SessionTabs from "./components/SessionTabs.jsx";
import Toast from "./components/Toast.jsx";
import MobileNav from "./components/MobileNav.jsx";
import BudgetBar from "./components/BudgetBar.jsx";
const FilesPanel = lazy(() => import("./components/FilesPanel.jsx"));
const CommandPalette = lazy(() => import("./components/CommandPalette.jsx"));
const FileSwitcher = lazy(() => import("./components/FileSwitcher.jsx"));
const SettingsModal = lazy(() => import("./components/SettingsModal.jsx"));
const DiffApprovalModal = lazy(() => import("./components/DiffApprovalModal.jsx"));

function Shell() {
  const { leftSidebarOpen, setLeftSidebarOpen, rightPanelOpen, setRightPanelOpen, commandPaletteOpen, setCommandPaletteOpen, settingsOpen, setSettingsOpen } = useUI();
  const { files } = useFiles();
  const { isStreaming } = useChat();
  const [mobileView, setMobileView] = useState("chat");
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 900);

  // Auto-open disabled per user request: never open the files panel
  // automatically when files are created. The user opens it explicitly
  // via the TopBar button or Cmd+J. This prevents the layout from
  // jumping during generation.

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onKey = useCallback((e) => {
    const target = e.target;
    const isInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (isInput && !(e.metaKey || e.ctrlKey)) return;
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && e.key.toLowerCase() === "b") { e.preventDefault(); setLeftSidebarOpen((v) => !v); }
    if (modifier && e.key.toLowerCase() === "j") { e.preventDefault(); setRightPanelOpen((v) => !v); }
    if (modifier && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandPaletteOpen(true); }
    if (modifier && e.key.toLowerCase() === "n") { e.preventDefault(); window.dispatchEvent(new CustomEvent("codeforge:new-chat")); }
    if (e.key === "Escape") {
      if (commandPaletteOpen || settingsOpen) { setCommandPaletteOpen(false); setSettingsOpen(false); }
      else if (leftSidebarOpen) setLeftSidebarOpen(false);
      else if (rightPanelOpen) setRightPanelOpen(false);
      else { setCommandPaletteOpen(false); setSettingsOpen(false); }
    }
  }, [leftSidebarOpen, rightPanelOpen, commandPaletteOpen, settingsOpen, setLeftSidebarOpen, setRightPanelOpen, setCommandPaletteOpen, setSettingsOpen]);

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const handleMenu = () => setLeftSidebarOpen((v) => !v);
  const handleFiles = () => {
    if (isMobile) setMobileView((v) => v === "files" ? "chat" : "files");
    else setRightPanelOpen((v) => !v);
  };

  return (
    <div className={`shell ${leftSidebarOpen ? "left-open" : ""} ${rightPanelOpen ? "right-open" : ""}`}>
      {leftSidebarOpen && !isMobile && (
        <div className="sidebar-desktop-overlay" onClick={() => setLeftSidebarOpen(false)} aria-hidden="true" />
      )}
      <Sidebar open={leftSidebarOpen} onClose={() => setLeftSidebarOpen(false)} isMobile={isMobile} />
      <div className="shell-main">
        <TopBar onMenuClick={handleMenu} onFilesClick={handleFiles} leftSidebarOpen={leftSidebarOpen} rightPanelOpen={rightPanelOpen || (isMobile && mobileView === "files")} isMobile={isMobile} />
        {!isMobile && <SessionTabs />}
        <BudgetBar />
        <div className="shell-content">
          {(!isMobile || mobileView === "chat") && <ChatPanel />}
          {isMobile && <Suspense fallback={null}><FilesPanel open={false} onClose={() => setMobileView("chat")} isMobile mobileVisible={mobileView === "files"} /></Suspense>}
        </div>
        {isMobile && <MobileNav view={mobileView} onChange={setMobileView} />}
      </div>
      {!isMobile && <Suspense fallback={null}><FilesPanel open={rightPanelOpen} onClose={() => setRightPanelOpen(false)} isMobile={false} mobileVisible={false} /></Suspense>}
      <Suspense fallback={null}><CommandPalette /></Suspense>
      <Suspense fallback={null}><FileSwitcher /></Suspense>
      <Suspense fallback={null}><SettingsModal /></Suspense>
      <Suspense fallback={null}><DiffApprovalModal /></Suspense>
      <Toast />
    </div>
  );
}

function SessionsBridge() {
  const { settings } = useSettings();
  const { notify } = useUI();
  const { activeChatId, activeSession, newChat, ready } = useSessions();
  const chatId = activeChatId || activeSession?.id;

  useEffect(() => {
    // Wait for the server/local session list to hydrate. Otherwise a fresh
    // browser can create a blank chat before the real history arrives.
    if (ready && !chatId) void newChat();
  }, [ready, chatId, newChat]);

  useEffect(() => {
    const handler = () => { void newChat(); };
    window.addEventListener("codeforge:new-chat", handler);
    return () => window.removeEventListener("codeforge:new-chat", handler);
  }, [newChat]);

  if (!chatId) return null;

  return (
    <FilesProvider key={`files-${chatId}`} chatId={chatId} initialFiles={activeSession?.files || []} sessionLoaded={ready && activeSession?.id === chatId} notify={notify}>
      <ChatProvider key={`chat-${chatId}`} chatId={chatId} settings={settings} notify={notify} initialSession={activeSession || { id: chatId }} sessionLoaded={ready && activeSession?.id === chatId}>
        <Shell />
      </ChatProvider>
    </FilesProvider>
  );
}

function OnboardingTour({ onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className="modal-head"><span>Добро пожаловать в CodeForge</span><button className="icon-btn" onClick={onClose}><X size={14} /></button></div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          <p>Это мульти-агентная студия: опишите задачу — агент создаст сайт, приложение или скрипт.</p>
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            <li>📁 Файлы справа — редактируйте, дублируйте, смотрите превью.</li>
            <li>👁 Превью — device, масштаб, тёмная тема, a11y/SEO, остановка.</li>
            <li>💬 Чат — поиск (режим .*), закрепить, закладки, экспорт PDF/JSON.</li>
            <li>⚙ Настройки — модель, план-утверждение, предохранитель.</li>
          </ul>
        </div>
        <button className="btn-new-chat" style={{ marginTop: 12, width: "100%" }} onClick={onClose}>Начать</button>
      </div>
    </div>
  );
}

function AppInner() {
  const { notify } = useUI();
  const [showTour, setShowTour] = React.useState(() => {
    try { return !localStorage.getItem("codeforge_onboarded"); } catch { return false; }
  });
  const closeTour = () => {
    try { localStorage.setItem("codeforge_onboarded", "1"); } catch {}
    setShowTour(false);
  };
  return (
    <SessionsProvider notify={notify}>
      <SessionsBridge />
      {showTour && <OnboardingTour onClose={closeTour} />}
    </SessionsProvider>
  );
}

export default function App() {
  return <SettingsProvider><UIProvider><AppInner /></UIProvider></SettingsProvider>;
}
