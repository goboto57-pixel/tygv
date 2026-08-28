import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react({
      // Fast refresh for better DX
      fastRefresh: true,
      // Babel config for optimized builds
      babel: {
        plugins: [
          ["@babel/plugin-transform-react-constant-elements"],
          ["@babel/plugin-transform-react-inline-elements"],
        ],
      },
    }),
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
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-markdown"],
          "vendor-ui": ["framer-motion", "lucide-react"],
          "vendor-editor": ["react-syntax-highlighter"],
          "vendor-utils": ["jszip", "file-saver"],
          "webcontainer": ["@webcontainer/api"],
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
      drop: ["console", "debugger"],
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
