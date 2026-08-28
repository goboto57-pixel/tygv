import React, { useState, useEffect } from "react";
import { AppProvider, useApp } from "./context/AppContext.jsx";
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

function Shell() {
  const {
    loadChatList,
    newChat,
    settings,
    leftSidebarOpen,
    setLeftSidebarOpen,
    rightPanelOpen,
    setRightPanelOpen
  } = useApp();
  const [mobileView, setMobileView] = useState("chat"); // 'chat' | 'files'
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    loadChatList();
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [loadChatList]);

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newChat();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setLeftSidebarOpen((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setRightPanelOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, setLeftSidebarOpen, setRightPanelOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.fontSize = settings.fontSize;
  }, [settings.theme, settings.fontSize]);

  return (
    <div className={`shell ${leftSidebarOpen ? "left-open" : ""} ${rightPanelOpen ? "right-open" : ""}`}>
      <Sidebar
        open={leftSidebarOpen}
        onClose={() => setLeftSidebarOpen(false)}
        isMobile={isMobile}
      />
      <div className="shell-main">
        <TopBar
          onMenuClick={() => setLeftSidebarOpen((v) => !v)}
          onFilesClick={() => setRightPanelOpen((v) => !v)}
          leftSidebarOpen={leftSidebarOpen}
          rightPanelOpen={rightPanelOpen}
          isMobile={isMobile}
        />
        {!isMobile && <SessionTabs />}
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
      <Toast />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
