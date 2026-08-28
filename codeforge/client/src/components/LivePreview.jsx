import React, { useMemo } from "react";

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
    return content;
  }, [files, activeFile]);

  return (
    <div className="live-preview">
      <iframe
        title="preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-same-origin"
        className="live-preview-frame"
      />
    </div>
  );
}
