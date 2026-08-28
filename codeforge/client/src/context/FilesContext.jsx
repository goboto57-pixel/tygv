import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

const FilesContext = createContext(null);
const API_BASE = import.meta.env.VITE_API_URL || "/api";

export function FilesProvider({ children, chatId, notify }) {
  const [files, setFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);

  const openFileTab = useCallback((path) => {
    setActiveFile(path);
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const closeFileTab = useCallback(
    (path) => {
      setOpenFiles((prev) => {
        const next = prev.filter((p) => p !== path);
        if (activeFile === path) {
          setActiveFile(next[next.length - 1] || null);
        }
        return next;
      });
    },
    [activeFile]
  );

  const updateFileContent = useCallback((path, content) => {
    setFiles((prev) => {
      const next = prev.map((f) => (f.path === path ? { ...f, content } : f));
      if (chatId) {
        fetch(`${API_BASE}/projects/chats/${chatId}/files`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: next })
        }).catch(() => {
          notify("Не удалось сохранить файл на сервере", "error");
        });
      }
      return next;
    });
  }, [chatId, notify]);

  const uploadFiles = useCallback(async (fileList) => {
    const formData = new FormData();
    Array.from(fileList).forEach((f) => formData.append("files", f));
    try {
      const res = await fetch(`${API_BASE}/files/upload`, { method: "POST", body: formData });
      const data = await res.json();
      const newFiles = (data.files || []).filter((f) => f.isText);
      setFiles((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]));
        newFiles.forEach((f) => map.set(f.path, { path: f.path, content: f.content }));
        return Array.from(map.values());
      });
      if (newFiles.length) setActiveFile(newFiles[0].path);
      notify(`Загружено файлов: ${data.files?.length || 0}`, "success");
    } catch (e) {
      notify("Ошибка загрузки файлов", "error");
    }
  }, [notify]);

  const replaceFiles = useCallback((newFiles) => {
    setFiles(newFiles || []);
    if (newFiles?.[0]?.path) {
      setActiveFile(newFiles[0].path);
      setOpenFiles([newFiles[0].path]);
    } else {
      setActiveFile(null);
      setOpenFiles([]);
    }
  }, []);

  const value = useMemo(() => ({
    files,
    activeFile,
    setActiveFile,
    openFiles,
    openFileTab,
    closeFileTab,
    updateFileContent,
    uploadFiles,
    replaceFiles,
    setFiles,
  }), [
    files,
    activeFile,
    openFiles,
    openFileTab,
    closeFileTab,
    updateFileContent,
    uploadFiles,
    replaceFiles,
  ]);

  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}

export function useFiles() {
  const ctx = useContext(FilesContext);
  if (!ctx) throw new Error("useFiles must be used within FilesProvider");
  return ctx;
}