import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Required for @webcontainer/api (SharedArrayBuffer / cross-origin
    // isolation). "credentialless" (not "require-corp") is used deliberately:
    // require-corp would also block the Google Fonts stylesheet/font
    // requests in index.html since fonts.googleapis.com doesn't send a
    // Cross-Origin-Resource-Policy header — credentialless still isolates
    // the page but only restricts *credentialed* cross-origin requests.
    headers: {
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin"
    },
    proxy: {
      "/api": {
        target: "http://localhost:10000",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false
  }
});
