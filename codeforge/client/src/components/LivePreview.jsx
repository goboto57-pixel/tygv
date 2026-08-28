import React, { useMemo, useState, useEffect, useCallback } from "react";
import { Maximize2, X, ExternalLink, RefreshCw } from "lucide-react";

// Builds a self-contained HTML document from the project's files so the
// preview renders exactly what the agent produced — including CSS and JS that
// live in separate files. Relative <link>/<script src> references are inlined
// so the iframe doesn't try to fetch them from the app origin (which 404s).
export default function LivePreview({ files, activeFile }) {
  const srcDoc = useMemo(() => {
    if (!Array.isArray(files) || files.length === 0) {
      return "<p style='color:#888;font-family:sans-serif;padding:20px'>Нет файлов для превью.</p>";
    }

    const byPath = new Map();
    for (const f of files) byPath.set(f.path, f.content || "");

    // Pick the HTML entry point: the active file if it's HTML, else index.html,
    // else the first .html file we can find.
    let htmlPath = null;
    if (activeFile && activeFile.endsWith(".html") && byPath.has(activeFile)) {
      htmlPath = activeFile;
    } else if (byPath.has("index.html")) {
      htmlPath = "index.html";
    } else {
      htmlPath = files.find((f) => f.path.endsWith(".html"))?.path || null;
    }
    if (!htmlPath) {
      return "<p style='color:#888;font-family:sans-serif;padding:20px'>Нет HTML-файла для превью.</p>";
    }

    let content = String(byPath.get(htmlPath) || "");

    const resolve = (href) => {
      if (!href) return null;
      const clean = href.split("#")[0].split("?")[0].trim();
      if (!clean || clean.startsWith("http") || clean.startsWith("//") || clean.startsWith("data:")) return null;
      // strip leading "./" or "/"
      const rel = clean.replace(/^\.?\//, "");
      if (byPath.has(rel)) return byPath.get(rel);
      // try basename match as a fallback
      const base = rel.split("/").pop();
      const found = files.find((f) => f.path.endsWith("/" + base) || f.path === base);
      return found ? found.content : null;
    };

    // Inline <link rel="stylesheet" href="...">
    content = content.replace(/<link\b[^>]*>/gi, (tag) => {
      const isStyle = /rel\s*=\s*["']?stylesheet["']?/i.test(tag);
      const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!isStyle || !hrefMatch) return tag;
      const css = resolve(hrefMatch[1]);
      if (css == null) return tag;
      return `<style data-inlined-from="${hrefMatch[1]}">${String(css).replace(/<\/style>/gi, "<\\/style>")}</style>`;
    });

    // Inline <script src="..."> (skip external/module CDN scripts)
    content = content.replace(/<script\b([^>]*)src\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, before, src, after) => {
      if (/src\s*=\s*["']https?:/i.test(tag)) return tag;
      const js = resolve(src);
      if (js == null) return tag;
      return `<script${before}${after}>${String(js).replace(/<\/script>/gi, "<\\/script>")}</script>`;
    });

    // Any remaining .css files not referenced via <link> get injected at </head>.
    const css = files.filter((f) => f.path.endsWith(".css"));
    const js = files.filter((f) => f.path.endsWith(".js") && !f.path.includes("node_modules"));
    const escapeStyle = (c) => String(c).replace(/<\/style>/gi, "<\\/style>");
    const escapeScript = (c) => String(c).replace(/<\/script>/gi, "<\\/script>");
    const styleTags = css.map((f) => `<style data-file="${f.path}">${escapeStyle(f.content)}</style>`).join("\n");
    const scriptTags = js.map((f) => `<script data-file="${f.path}">${escapeScript(f.content)}</script>`).join("\n");

    if (styleTags) {
      if (content.includes("</head>")) content = content.replace("</head>", `${styleTags}</head>`);
      else content = styleTags + content;
    }
    if (scriptTags) {
      if (content.includes("</body>")) content = content.replace("</body>", `${scriptTags}</body>`);
      else content += scriptTags;
    }
    const errorScript = `<script>(function(){try{var o=console.error;console.error=function(){try{parent.postMessage({type:'preview-error',text:Array.from(arguments).join(' ')},'*')}catch(e){} return o.apply(console,arguments)};window.onerror=function(m,s,l,c,e){try{parent.postMessage({type:'preview-error',text:m+' at '+l+':'+c},'*')}catch(e){}};window.onunhandledrejection=function(e){try{parent.postMessage({type:'preview-error',text:String(e.reason)},'*')}catch(e){}};}catch(e){}})();</script>`;
    if (content.includes("</body>")) content = content.replace("</body>", errorScript + "</body>");
    else content += errorScript;
    return content;
  }, [files, activeFile]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [errors, setErrors] = useState([]);
  const [device, setDevice] = useState("desktop"); // desktop|tablet|mobile
  const [isDark, setIsDark] = useState(false);
  const [scale, setScale] = useState(100);
  const [showA11y, setShowA11y] = useState(false);
  const [stopped, setStopped] = useState(false);

  const a11y = useMemo(() => {
    if (!srcDoc) return { issues: [], score: 100 };
    const issues = [];
    const html = srcDoc;
    const imgs = (html.match(/<img[^>]*>/gi) || []);
    if (imgs.length && !imgs.every((t) => /alt=/i.test(t))) issues.push("Есть <img> без alt");
    if (!/<html[^>]*lang=/i.test(html)) issues.push("<html> без lang");
    if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) issues.push("Нет <title>");
    if (!/<meta[^>]*name=["']description["']/i.test(html)) issues.push("Нет meta description");
    if (!/<meta[^>]*name=["']viewport["']/i.test(html)) issues.push("Нет meta viewport");
    if (!/<h1[\s>]/i.test(html)) issues.push("Нет <h1>");
    const score = Math.max(0, 100 - issues.length * 14);
    return { issues, score };
  }, [srcDoc]);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data && e.data.type === "preview-error") setErrors((prev) => [...prev.slice(-8), String(e.data.text).slice(0, 300)]);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [refreshKey]);
  useEffect(() => { setErrors([]); }, [srcDoc]);

  const openInNewTab = useCallback(() => {
    try {
      const blob = new Blob([srcDoc], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch {}
  }, [srcDoc]);
  const copyUrl = useCallback(async () => {
    try {
      const blob = new Blob([srcDoc], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      await navigator.clipboard.writeText(url);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {}
  }, [srcDoc]);
  const frameStyle = device === "mobile" ? { maxWidth: 375, margin: "0 auto", border: "1px solid var(--border-strong)" } : device === "tablet" ? { maxWidth: 768, margin: "0 auto", border: "1px solid var(--border-strong)" } : {};

  const toggleFullscreen = useCallback(() => setIsFullscreen((v) => !v), []);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e) => { if (e.key === "Escape") closeFullscreen(); };
    window.addEventListener("keydown", onKey);
    // lock body scroll
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [isFullscreen, closeFullscreen]);

  const iframe = stopped ? null : (
    <iframe
      key={refreshKey}
      title="preview"
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-same-origin"
      className="live-preview-frame"
    />
  );

  if (isFullscreen) {
    return (
      <div className="live-preview">
        <div className="live-preview-toolbar">
          <span className="live-preview-label">Превью</span>
          <div className="live-preview-actions">
            <button className="icon-btn" onClick={openInNewTab} title="Открыть в новой вкладке"><ExternalLink size={14} /></button>
            <button className="icon-btn" onClick={() => setRefreshKey((k) => k + 1)} title="Обновить превью"><RefreshCw size={14} /></button>
            <button className="icon-btn" onClick={toggleFullscreen} title="Выйти из полноэкранного (Esc)"><X size={16} /></button>
          </div>
        </div>
        <iframe
          key={`fs-${refreshKey}`}
          title="preview"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-same-origin"
          className="live-preview-frame"
          style={{ opacity: 0.3 }}
        />
        <div className="live-preview-fullscreen" onClick={closeFullscreen}>
          <div className="live-preview-fullscreen-bar" onClick={(e) => e.stopPropagation()}>
            <span>Превью — полноэкранный (Esc для выхода)</span>
            <div className="live-preview-actions">
              <button className="icon-btn" onClick={() => setRefreshKey((k) => k + 1)} title="Обновить"><RefreshCw size={14} /></button>
              <button className="icon-btn" onClick={closeFullscreen} title="Закрыть (Esc)"><X size={18} /></button>
            </div>
          </div>
          <div className="live-preview-fullscreen-frame-wrap" onClick={(e) => e.stopPropagation()}>
            <iframe
              key={`fs-inner-${refreshKey}`}
              title="preview-fullscreen"
              srcDoc={srcDoc}
              sandbox="allow-scripts allow-same-origin"
              className="live-preview-frame"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="live-preview">
      <div className="live-preview-toolbar">
        <span className="live-preview-label">Превью</span>
        <div className="live-preview-actions" style={{ gap: 4, flexWrap: "wrap" }}>
          <button className={`icon-btn ${device === "mobile" ? "icon-btn-active" : ""}`} onClick={() => setDevice("mobile")} title="Mobile 375px">📱</button>
          <button className={`icon-btn ${device === "tablet" ? "icon-btn-active" : ""}`} onClick={() => setDevice("tablet")} title="Tablet 768px">📱</button>
          <button className={`icon-btn ${device === "desktop" ? "icon-btn-active" : ""}`} onClick={() => setDevice("desktop")} title="Desktop">🖥️</button>
          <input type="range" min="50" max="150" value={scale} onChange={(e) => setScale(Number(e.target.value))} style={{ width: 60 }} title={`Масштаб ${scale}%`} />
          <span style={{ fontSize: "10px", color: "var(--text-tertiary)", minWidth: 32 }}>{scale}%</span>
          <button className={`icon-btn ${isDark ? "icon-btn-active" : ""}`} onClick={() => setIsDark((v) => !v)} title={isDark ? "Светлая тема превью" : "Тёмная тема превью"}>{isDark ? "🌙" : "☀️"}</button>
          <button className={`icon-btn ${showA11y ? "icon-btn-active" : ""}`} onClick={() => setShowA11y((v) => !v)} title={`a11y/SEO (WC ${a11y.score})`}>♿</button>
          <button className={`icon-btn ${stopped ? "icon-btn-active" : ""}`} onClick={() => setStopped((v) => !v)} title={stopped ? "Запустить превью" : "Остановить превью"}>{stopped ? "▶" : "⏸"}</button>
          <button className="icon-btn" onClick={copyUrl} title="Копировать URL превью"><ExternalLink size={14} /></button>
          <button className="icon-btn" onClick={openInNewTab} title="Открыть в новой вкладке"><ExternalLink size={14} /></button>
          <button className="icon-btn" onClick={() => setRefreshKey((k) => k + 1)} title="Обновить превью (hot reload)"><RefreshCw size={14} /></button>
          <button className="icon-btn" onClick={toggleFullscreen} title="На весь экран"><Maximize2 size={14} /></button>
        </div>
      </div>
      {showA11y && (
        <div className="live-preview-a11y">
          <div className="a11y-head">Доступность/SEO: <b style={{ color: a11y.score > 70 ? "#4ade80" : a11y.score > 40 ? "#fbbf24" : "#f87171" }}>{a11y.score}%</b></div>
          {a11y.issues.length === 0 ? <div className="a11y-ok">✓ Базовые проверки пройдены</div> : a11y.issues.map((i, k) => <div key={k} className="a11y-issue">• {i}</div>)}
        </div>
      )}
      {stopped && <div className="live-preview-stopped" onClick={() => setStopped(false)}>Превью остановлено — нажмите ▶ чтобы запустить</div>}
      <div style={{ ...frameStyle, transform: `scale(${scale / 100})`, transformOrigin: "top center", background: isDark ? "#111" : "#fff" }}>{iframe}</div>
      {errors.length > 0 && (
        <div className="live-preview-errors">
          {errors.map((e, i) => (
            <div key={i} className="live-preview-error">⚠ {e}</div>
          ))}
          <button className="live-preview-errors-clear" onClick={() => setErrors([])}>очистить</button>
        </div>
      )}
    </div>
  );
}
