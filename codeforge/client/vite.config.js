import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
  ],
  server: {
    port: 5173,
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin"
    },
    proxy: {
      "/api": {
        target: "http://localhost:10000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    minify: "esbuild",
    target: "es2022",
    cssCodeSplit: true,
    modulePreload: { polyfill: true },
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("react-syntax-highlighter")) return "vendor-editor";
          if (id.includes("framer-motion")) return "vendor-motion";
          if (id.includes("react-markdown") || id.includes("react-syntax-highlighter")) return "vendor-markdown";
          if (id.includes("jszip") || id.includes("file-saver")) return "vendor-utils";
          if (id.includes("@webcontainer")) return "webcontainer";
          if (id.includes("node_modules")) return "vendor";
        },
        chunkFileNames: "assets/js/[name]-[hash].js",
        entryFileNames: "assets/js/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split(".");
          const ext = info[info.length - 1];
          if (/png|jpe?g|svg|gif|tiff|bmp|ico/i.test(ext)) {
            return `assets/img/[name]-[hash].${ext}`;
          }
          if (/css/i.test(ext)) {
            return `assets/css/[name]-[hash].${ext}`;
          }
          return `assets/[name]-[hash].${ext}`;
        },
      },
    },
    esbuild: {
      drop: ["debugger"],
      pure: ["console.log", "console.debug", "console.info"],
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "framer-motion",
      "lucide-react",
      "react-markdown",
      "react-syntax-highlighter",
      "jszip",
      "file-saver",
    ],
    exclude: ["@webcontainer/api"],
  },
});
