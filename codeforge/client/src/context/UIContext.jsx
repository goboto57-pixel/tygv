import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

const UIContext = createContext(null);

export function UIProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [terminalLog, setTerminalLog] = useState([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  const notify = useCallback((text, kind = "info") => {
    setToast({ text, kind, id: Date.now() + Math.floor(Math.random() * 1000) });
  }, []);

  const clearTerminal = useCallback(() => {
    setTerminalLog([]);
  }, []);

  const addTerminalEntry = useCallback((entry) => {
    setTerminalLog((prev) => [...prev, entry].slice(-500));
  }, []);

  const value = useMemo(() => ({
    toast,
    setToast,
    notify,
    terminalLog,
    terminalOpen,
    setTerminalOpen,
    clearTerminal,
    addTerminalEntry,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    leftSidebarOpen,
    setLeftSidebarOpen,
    rightPanelOpen,
    setRightPanelOpen,
  }), [
    toast,
    terminalLog,
    terminalOpen,
    commandPaletteOpen,
    settingsOpen,
    leftSidebarOpen,
    rightPanelOpen,
    notify,
    clearTerminal,
    addTerminalEntry,
  ]);

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI() {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within UIProvider");
  return ctx;
}