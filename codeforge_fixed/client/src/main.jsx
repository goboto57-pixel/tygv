import React from "react";
import ReactDOM from "react-dom/client";
import "./apiSecret.js";
import App from "./App.jsx";
import AppErrorBoundary from "./components/AppErrorBoundary.jsx";
import "./styles/tokens.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Force an update check on every load instead of trusting the browser's
      // own (often lazy, once-a-day) background check — with the old
      // cache-first sw.js this didn't matter much since even a new worker
      // still served the frozen cache, but now that the cache is versioned
      // (see sw.js) we want new deploys to actually take effect promptly.
      reg.update().catch(() => {});
    }).catch(() => {});
  });
}
