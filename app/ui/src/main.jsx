import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import App from "./App.jsx";
import { api } from "./api/client.js";

// The app shell loads this page while the daemon may still be starting, and the
// boot fetches (ui config, settings, projects, templates) run once on mount — so
// mount only after the daemon answers.
async function whenDaemonUp() {
  for (;;) {
    try { await api.health(); return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
}

whenDaemonUp().then(() => createRoot(document.getElementById("root")).render(<App />));
