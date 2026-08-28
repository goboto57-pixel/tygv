import React, { useEffect, useRef, useState, useCallback } from "react";
import { RotateCw, TerminalSquare, ChevronDown, AlertTriangle, Maximize2, X } from "lucide-react";
import {
  isWebContainerSupported,
  getContainer,
  filesToTree,
  syncFile,
  removeFile,
  pickDevScript
} from "../webcontainer/wcManager.js";

// Real Node.js dev-server preview (StackBlitz's WebContainer engine) — runs
// an actual `npm install` + `npm run dev` inside the browser tab via WASM,
// as opposed to LivePreview.jsx which just stitches static HTML/CSS/JS into
// an iframe srcDoc and can't handle bundlers, npm packages, or frameworks
// that need a real dev server (React/Vue/Svelte apps, API routes, etc).
export default function WebContainerPreview({ files }) {
  const [status, setStatus] = useState("idle"); // idle|booting|installing|starting|ready|error|unsupported
  const [log, setLog] = useState([]);
  const [logOpen, setLogOpen] = useState(true);
  const [previewUrl, setPreviewUrl] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  const containerRef = useRef(null);
  const prevFilesRef = useRef(new Map()); // path -> content, last synced state
  const devProcessRef = useRef(null);
  const bootTokenRef = useRef(0); // guards against stale async work after a restart

  const appendLog = useCallback((line) => {
    setLog((prev) => [...prev.slice(-400), line]);
  }, []);

  const pipeToLog = (stream, prefix = "") =>
    stream.pipeTo(
      new WritableStream({
        write(chunk) {
          appendLog(prefix + chunk);
        }
      })
    ).catch((e) => appendLog(`[pipe error] ${e.message}`));

  const boot = useCallback(async () => {
    if (!isWebContainerSupported()) {
      setStatus("unsupported");
      return;
    }
    const myToken = ++bootTokenRef.current;
    setStatus("booting");
    setErrorMsg("");
    setLog([]);
    try {
      appendLog("$ booting webcontainer...");
      const container = await getContainer();
      if (bootTokenRef.current !== myToken) return; // superseded by a newer boot
      containerRef.current = container;

      // Use once-like handling and store off handlers to avoid leak on restart
      const onReady = (port, url) => {
        if (bootTokenRef.current !== myToken) return;
        setPreviewUrl(url);
        setStatus("ready");
      };
      const onError = (err) => {
        if (bootTokenRef.current !== myToken) return;
        setErrorMsg(err.message || "WebContainer runtime error");
        setStatus("error");
      };
      // WebContainer API doesn't expose off, but we can wrap and ignore stale tokens
      container.on("server-ready", onReady);
      container.on("error", onError);

      appendLog("$ mounting project files...");
      const tree = filesToTree(files);
      await container.mount(tree);
      prevFilesRef.current = new Map(files.filter((f) => typeof f.content === "string").map((f) => [f.path, f.content]));

      const pkgFile = files.find((f) => f.path === "package.json");
      if (!pkgFile) {
        setErrorMsg("Нет package.json — WebContainer нечего запускать. Добавьте package.json со скриптом dev/start.");
        setStatus("error");
        return;
      }

      setStatus("installing");
      appendLog("$ npm install");
      const install = await container.spawn("npm", ["install"]);
      pipeToLog(install.output);
      const installExit = await install.exit;
      if (bootTokenRef.current !== myToken) return;
      if (installExit !== 0) {
        setErrorMsg(`npm install завершился с кодом ${installExit}`);
        setStatus("error");
        return;
      }

      const script = pickDevScript(pkgFile.content) || "dev";
      setStatus("starting");
      appendLog(`$ npm run ${script}`);
      const dev = await container.spawn("npm", ["run", script]);
      devProcessRef.current = dev;
      pipeToLog(dev.output);
      // status flips to "ready" from the server-ready listener above once
      // the dev server actually binds a port; if the process exits before
      // that happens, surface it as an error instead of hanging on "starting".
      dev.exit.then((code) => {
        if (bootTokenRef.current !== myToken) return;
        if (code !== 0 && code !== null) {
          setErrorMsg(`Dev-сервер завершился с кодом ${code}`);
          setStatus("error");
        }
      });
    } catch (err) {
      if (bootTokenRef.current !== myToken) return;
      setErrorMsg(err.message || String(err));
      setStatus("error");
    }
  }, [appendLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // Boot once on first mount of this tab.
  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Incremental sync: when `files` changes after the container is running,
  // push only the diff so Vite/webpack HMR picks it up instead of paying
  // for a full reboot + reinstall on every keystroke-driven edit.
  useEffect(() => {
    if (status !== "ready" && status !== "starting") return;
    const container = containerRef.current;
    if (!container) return;

    const prev = prevFilesRef.current;
    const next = new Map(files.filter((f) => typeof f.content === "string").map((f) => [f.path, f.content]));

    (async () => {
      let packageJsonChanged = false;
      const ops = [];
      for (const [path, content] of next.entries()) {
        if (prev.get(path) !== content) {
          if (path === "package.json") packageJsonChanged = true;
          ops.push(syncFile(container, path, content));
        }
      }
      for (const path of prev.keys()) {
        if (!next.has(path)) ops.push(removeFile(container, path));
      }
      await Promise.allSettled(ops);
      prevFilesRef.current = next;
      if (packageJsonChanged) {
        appendLog("$ package.json changed — переустановите зависимости вручную (кнопка \u21bb), автопереустановка отключена для скорости.");
      }
    })();
  }, [files, status, appendLog]);

  const restart = () => {
    bootTokenRef.current++; // invalidate any in-flight work from the old run
    devProcessRef.current?.kill?.();
    devProcessRef.current = null;
    setPreviewUrl("");
    boot();
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e) => { if (e.key === "Escape") setIsFullscreen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [isFullscreen]);

  if (status === "unsupported") {
    return (
      <div className="wc-preview wc-preview-message">
        <AlertTriangle size={22} />
        <p>
          WebContainer недоступен: браузер или сервер не отдаёт заголовки кросс-происхождённой изоляции
          (COOP/COEP), либо это Safari/Firefox без нужной поддержки SharedArrayBuffer. Попробуйте свежий
          Chrome/Edge.
        </p>
      </div>
    );
  }

  return (
    <div className="wc-preview">
      <div className="wc-preview-toolbar">
        <span className={`wc-status-dot wc-status-${status}`} />
        <span className="wc-status-label">
          {status === "booting" && "Запуск WebContainer…"}
          {status === "installing" && "npm install…"}
          {status === "starting" && "Запуск dev-сервера…"}
          {status === "ready" && "Готово"}
          {status === "error" && `Ошибка: ${errorMsg}`}
        </span>
        <button className="wc-toolbar-btn" onClick={restart} title="Перезапустить">
          <RotateCw size={13} />
        </button>
        <button className="wc-toolbar-btn" onClick={() => setLogOpen((v) => !v)} title="Показать/скрыть лог">
          <TerminalSquare size={13} />
          <ChevronDown size={12} style={{ transform: logOpen ? "rotate(180deg)" : "none" }} />
        </button>
        {previewUrl && (
          <button className="wc-toolbar-btn" onClick={() => setIsFullscreen((v) => !v)} title={isFullscreen ? "Выйти из полноэкранного" : "На весь экран"}>
            {isFullscreen ? <X size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
      </div>

      {logOpen && (status !== "ready" || log.length > 0) && (
        <div className="wc-preview-log">
          {log.map((line, i) => (
            <div key={i} className="wc-preview-log-line">
              {line}
            </div>
          ))}
        </div>
      )}

      <div className="wc-preview-frame-wrap">
        {previewUrl ? (
          <iframe title="webcontainer-preview" src={previewUrl} className="live-preview-frame" />
        ) : (
          <div className="wc-preview-placeholder">
            {status === "error" ? "Не удалось запустить превью." : "Собираем окружение…"}
          </div>
        )}
      </div>
      {isFullscreen && previewUrl && (
        <div className="live-preview-fullscreen" onClick={() => setIsFullscreen(false)}>
          <div className="live-preview-fullscreen-bar" onClick={(e) => e.stopPropagation()}>
            <span>Превью — полноэкранный (Esc для выхода)</span>
            <button className="icon-btn" onClick={() => setIsFullscreen(false)}><X size={18} /></button>
          </div>
          <div className="live-preview-fullscreen-frame-wrap" onClick={(e) => e.stopPropagation()}>
            <iframe title="webcontainer-preview-fs" src={previewUrl} className="live-preview-frame" />
          </div>
        </div>
      )}
    </div>
  );
}
