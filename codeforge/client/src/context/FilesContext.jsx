import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const FilesContext = createContext(null);
const API_BASE = import.meta.env.VITE_API_URL || "/api";

export function FilesProvider({ children, chatId, notify, initialFiles = [], sessionLoaded = false }) {
  const [files, setFilesState] = useState(() => (Array.isArray(initialFiles) ? initialFiles : []));
  const [activeFile, setActiveFile] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);

  useEffect(() => {
    let next = Array.isArray(initialFiles) ? initialFiles : [];
    if (sessionLoaded && next.length === 0 && chatId) {
      try {
        const cached = JSON.parse(localStorage.getItem(`codeforge_files_${chatId}`) || "null");
        if (Array.isArray(cached) && cached.length) next = cached;
      } catch {}
    }
    setFilesState(next);
    setOpenFiles((prev) => prev.filter((p) => next.some((f) => f.path === p)));
    setActiveFile((prev) => next.some((f) => f.path === prev) ? prev : next[0]?.path || null);
  }, [initialFiles, chatId, sessionLoaded]);

  const setFiles = useCallback((updater) => {
    setFilesState((prev) => typeof updater === "function" ? updater(prev) : (updater || []));
  }, []);

  useEffect(() => {
    if (!chatId || !sessionLoaded) return undefined;
    const timer = setTimeout(async () => {
      try {
        localStorage.setItem(`codeforge_files_${chatId}`, JSON.stringify(files));
      } catch {}
      try {
        const res = await fetch(`${API_BASE}/projects/chats/${encodeURIComponent(chatId)}/files`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        // Local cache is durable enough for immediate recovery; retry once
        // shortly after a transient outage so a quiet session still syncs.
        setTimeout(() => {
          try {
            if (chatId && sessionLoaded) {
              const body = JSON.stringify({ files });
              void fetch(`${API_BASE}/projects/chats/${encodeURIComponent(chatId)}/files`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body
              });
            }
          } catch {}
        }, 1800);
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [chatId, files, sessionLoaded]);


  useEffect(() => {
    const flushOnHide = () => {
      if (!chatId || !sessionLoaded) return;
      try { localStorage.setItem(`codeforge_files_${chatId}`, JSON.stringify(files)); } catch {}
      try {
        const payload = JSON.stringify({ files });
        // sendBeacon only does POST, so use fetch keepalive with PATCH; fallback to beacon if needed
        if (navigator.sendBeacon) {
          // try beacon with POST-compatible endpoint (server now accepts POST too), but prefer fetch keepalive
          const ok = false; // force fetch keepalive for correct PATCH semantics
          if (ok) {
            const body = new Blob([payload], { type: "application/json" });
            navigator.sendBeacon(`${API_BASE}/projects/chats/${encodeURIComponent(chatId)}/files`, body);
          }
        }
        // keepalive fetch supports PATCH correctly on pagehide
        fetch(`${API_BASE}/projects/chats/${encodeURIComponent(chatId)}/files`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true
        }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", flushOnHide);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushOnHide(); });
    return () => {
      window.removeEventListener("pagehide", flushOnHide);
      document.removeEventListener("visibilitychange", flushOnHide);
    };
  }, [chatId, files, sessionLoaded]);

  const openFileTab = useCallback((path) => {
    setActiveFile(path);
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const closeFileTab = useCallback((path) => {
    setOpenFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      if (activeFile === path) setActiveFile(next[next.length - 1] || null);
      return next;
    });
  }, [activeFile]);

  const updateFileContent = useCallback((path, content) => {
    setFiles((prev) => prev.map((f) => f.path === path ? { ...f, content } : f));
  }, [setFiles]);

  const uploadFiles = useCallback(async (fileList) => {
    const formData = new FormData();
    Array.from(fileList || []).forEach((f) => formData.append("files", f));
    try {
      const res = await fetch(`${API_BASE}/files/upload`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const newFiles = (data.files || []).filter((f) => f.isText);
      setFilesState((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]));
        newFiles.forEach((f) => map.set(f.path, { path: f.path, content: f.content }));
        return Array.from(map.values());
      });
      if (newFiles.length) openFileTab(newFiles[0].path);
      notify?.(`Загружено файлов: ${data.files?.length || 0}`, "success");
    } catch (e) {
      notify?.(`Ошибка загрузки файлов: ${e.message}`, "error");
    }
  }, [chatId, notify, openFileTab]);

  const replaceFiles = useCallback((newFiles) => {
    const next = Array.isArray(newFiles) ? newFiles : [];
    setFilesState(next);
    setActiveFile(next[0]?.path || null);
    setOpenFiles(next[0]?.path ? [next[0].path] : []);
    try { if (chatId) localStorage.setItem(`codeforge_files_${chatId}`, JSON.stringify(next)); } catch {}
  }, [chatId]);

  const value = useMemo(() => ({
    files, activeFile, setActiveFile, openFiles, openFileTab, closeFileTab,
    updateFileContent, uploadFiles, replaceFiles, setFiles, chatId
  }), [files, activeFile, openFiles, openFileTab, closeFileTab, updateFileContent, uploadFiles, replaceFiles, setFiles, chatId]);

  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}

export function useFiles() {
  const ctx = useContext(FilesContext);
  if (!ctx) throw new Error("useFiles must be used within FilesProvider");
  return ctx;
}
