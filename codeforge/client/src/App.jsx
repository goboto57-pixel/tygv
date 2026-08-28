import React, { useState, useEffect, useCallback } from "react";
import { ChatProvider, useChat } from "./context/ChatContext.jsx";
import { FilesProvider, useFiles } from "./context/FilesContext.jsx";
import { SessionsProvider, useSessions } from "./context/SessionsContext.jsx";
import { UIProvider, useUI } from "./context/UIContext.jsx";
import { SettingsProvider, useSettings } from "./context/SettingsContext.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import FilesPanel from "./components/FilesPanel.jsx";
import TopBar from "./components/TopBar.jsx";
import SessionTabs from "./components/SessionTabs.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import FileSwitcher from "./components/FileSwitcher.jsx";
import SettingsModal from "./components/SettingsModal.jsx";
import Toast from "./components/Toast.jsx";
import MobileNav from "./components/MobileNav.jsx";
import DiffApprovalModal from "./components/DiffApprovalModal.jsx";
import BudgetBar from "./components/BudgetBar.jsx";

function Shell() {
  const { leftSidebarOpen, setLeftSidebarOpen, rightPanelOpen, setRightPanelOpen, commandPaletteOpen, setCommandPaletteOpen, settingsOpen, setSettingsOpen } = useUI();
  const { files } = useFiles();
  const { isStreaming } = useChat();
  const [mobileView, setMobileView] = useState("chat");
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 900);

  // Auto-open files panel when agent starts creating files
  useEffect(() => {
    if (isStreaming && files.length > 0 && !rightPanelOpen && !isMobile) {
      setRightPanelOpen(true);
    }
  }, [isStreaming, files.length, rightPanelOpen, isMobile, setRightPanelOpen]);

  useEffect(() => {
    if (files.length > 0 && !rightPanelOpen && !isMobile) {
      // also auto-open when files appear (e.g. after first tool call)
      const t = setTimeout(() => setRightPanelOpen(true), 400);
      return () => clearTimeout(t);
    }
  }, [files.length]);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onKey = useCallback((e) => {
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && e.key.toLowerCase() === "b") { e.preventDefault(); setLeftSidebarOpen((v) => !v); }
    if (modifier && e.key.toLowerCase() === "j") { e.preventDefault(); setRightPanelOpen((v) => !v); }
    if (modifier && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandPaletteOpen(true); }
    if (modifier && e.key.toLowerCase() === "n") { e.preventDefault(); window.dispatchEvent(new CustomEvent("codeforge:new-chat")); }
    if (e.key === "Escape") { setCommandPaletteOpen(false); setSettingsOpen(false); }
  }, [setLeftSidebarOpen, setRightPanelOpen, setCommandPaletteOpen, setSettingsOpen]);

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
      <Sidebar open={leftSidebarOpen} onClose={() => setLeftSidebarOpen(false)} isMobile={isMobile} />
      <div className="shell-main">
        <TopBar onMenuClick={handleMenu} onFilesClick={handleFiles} leftSidebarOpen={leftSidebarOpen} rightPanelOpen={rightPanelOpen || (isMobile && mobileView === "files")} isMobile={isMobile} />
        {!isMobile && <SessionTabs />}
        <BudgetBar />
        <div className="shell-content">
          {(!isMobile || mobileView === "chat") && <ChatPanel />}
          {isMobile && <FilesPanel open={false} onClose={() => setMobileView("chat")} isMobile mobileVisible={mobileView === "files"} />}
        </div>
        {isMobile && <MobileNav view={mobileView} onChange={setMobileView} />}
      </div>
      {!isMobile && <FilesPanel open={rightPanelOpen} onClose={() => setRightPanelOpen(false)} isMobile={false} mobileVisible={false} />}
      <CommandPalette />
      <FileSwitcher />
      <SettingsModal />
      <DiffApprovalModal />
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

function AppInner() {
  const { notify } = useUI();
  return <SessionsProvider notify={notify}><SessionsBridge /></SessionsProvider>;
}

export default function App() {
  return <SettingsProvider><UIProvider><AppInner /></UIProvider></SettingsProvider>;
}
