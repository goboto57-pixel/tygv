import React, { useMemo } from "react";

export default function LivePreview({ files }) {
  const srcDoc = useMemo(() => {
    const html = files.find((f) => f.path.endsWith(".html"));
    if (!html) return "<p style='color:#888;font-family:sans-serif;padding:20px'>Нет HTML-файла для превью.</p>";

    let content = html.content;
    const css = files.filter((f) => f.path.endsWith(".css"));
    const js = files.filter((f) => f.path.endsWith(".js") && !f.path.includes("node_modules"));

    const styleTags = css.map((f) => `<style>${f.content}</style>`).join("\n");
    const scriptTags = js.map((f) => `<script>${f.content}</script>`).join("\n");

    if (content.includes("</head>")) {
      content = content.replace("</head>", `${styleTags}</head>`);
    } else {
      content = styleTags + content;
    }
    if (content.includes("</body>")) {
      content = content.replace("</body>", `${scriptTags}</body>`);
    } else {
      content += scriptTags;
    }
    return content;
  }, [files]);

  return (
    <div className="live-preview">
      <iframe
        title="preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="live-preview-frame"
      />
    </div>
  );
}
