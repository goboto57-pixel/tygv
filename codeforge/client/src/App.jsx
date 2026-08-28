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
  const {
    leftSidebarOpen,
    setLeftSidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
  } = useUI();
  const { loadChatList } = useSessions();

  const [mobileView, setMobileView] = useState("chat");
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    loadChatList();
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [loadChatList]);

  const onKey = useCallback(
    (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setLeftSidebarOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setRightPanelOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (e.key === "Escape") {
        setCommandPaletteOpen(false);
        setSettingsOpen(false);
      }
    },
    [setLeftSidebarOpen, setRightPanelOpen, setCommandPaletteOpen, setSettingsOpen]
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  return (
    <div className={`shell ${leftSidebarOpen ? "left-open" : ""} ${rightPanelOpen ? "right-open" : ""}`}>
      <Sidebar open={leftSidebarOpen} onClose={() => setLeftSidebarOpen(false)} isMobile={isMobile} />
      <div className="shell-main">
        <TopBar
          onMenuClick={() => setLeftSidebarOpen((v) => !v)}
          onFilesClick={() => setRightPanelOpen((v) => !v)}
          leftSidebarOpen={leftSidebarOpen}
          rightPanelOpen={rightPanelOpen}
          isMobile={isMobile}
        />
        {!isMobile && <SessionTabs />}
        <BudgetBar />
        <div className="shell-content">
          {(!isMobile || mobileView === "chat") && <ChatPanel />}
          {isMobile && (
            <FilesPanel
              open={rightPanelOpen}
              onClose={() => setRightPanelOpen(false)}
              isMobile={isMobile}
              mobileVisible={mobileView === "files"}
            />
          )}
        </div>
        {isMobile && <MobileNav view={mobileView} onChange={setMobileView} />}
      </div>
      {!isMobile && (
        <FilesPanel
          open={rightPanelOpen}
          onClose={() => setRightPanelOpen(false)}
          isMobile={isMobile}
          mobileVisible={false}
        />
      )}
      <CommandPalette />
      <FileSwitcher />
      <SettingsModal />
      <DiffApprovalModal />
      <Toast />
    </div>
  );
}

// Bridges Sessions (source of truth for chatId) down into Chat/Files,
// which both need chatId but must live *inside* SessionsProvider.
function SessionsBridge() {
  const { settings } = useSettings();
  const { notify } = useUI();
  const sessions = useSessions();
  const chatId = sessions.openSessions[0]?.id;

  return (
    <ChatProvider chatId={chatId} settings={settings} notify={notify}>
      <FilesProvider chatId={chatId} notify={notify}>
        <Shell />
      </FilesProvider>
    </ChatProvider>
  );
}

function AppInner() {
  const { notify } = useUI();

  return (
    <SessionsProvider notify={notify}>
      <SessionsBridge />
    </SessionsProvider>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <UIProvider>
        <AppInner />
      </UIProvider>
    </SettingsProvider>
  );
}
