import React, { useState, useEffect } from "react";
import { AppProvider, useApp } from "./context/AppContext.jsx";
import Sidebar from "./components/Sidebar.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import FilesPanel from "./components/FilesPanel.jsx";
import TopBar from "./components/TopBar.jsx";
import Toast from "./components/Toast.jsx";
import MobileNav from "./components/MobileNav.jsx";

function Shell() {
  const { loadChatList } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileView, setMobileView] = useState("chat"); // 'chat' | 'files'
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    loadChatList();
    const onResize = () => setIsMobile(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [loadChatList]);

  return (
    <div className="shell">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} isMobile={isMobile} />
      <div className="shell-main">
        <TopBar onMenuClick={() => setSidebarOpen(true)} isMobile={isMobile} />
        <div className="shell-content">
          {(!isMobile || mobileView === "chat") && <ChatPanel />}
          {(!isMobile || mobileView === "files") && <FilesPanel />}
        </div>
        {isMobile && <MobileNav view={mobileView} onChange={setMobileView} />}
      </div>
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
