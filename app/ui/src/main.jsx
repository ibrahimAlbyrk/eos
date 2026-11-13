import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import App from "./App.jsx";
import { api } from "./api/client.js";
import { receiveBoot } from "./api/boot.js";
import { holdUntilFirstPaint, releaseAfterPaint } from "./lib/firstPaint.js";
import { startPlugins } from "./plugins/runtime.js";
import { primeFromBoot } from "./state/bootPrime.js";

// The app shell loads this page while the daemon may still be starting, and the
// boot fetches (ui config, settings, projects, templates) run once on mount — so
// mount only after the daemon answers. The boot snapshot index.html asked for is
// that answer when it came: the reads it holds need no request.
async function whenDaemonUp() {
  if (await receiveBoot()) return;
  for (;;) {
    try { await api.health(); return; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
}

// React listens for every event type on its root and on each portal container
// (document.body here). An animationiteration listener anywhere in the document
// makes Blink service every running CSS animation — composited ones too — on
// main frames for the last ~40 ms before each iteration, to fire the event: 3–5
// main frames per iteration of every breathing dot, spin and halo. Nothing here
// uses onAnimationIteration (a handler would never fire), so React's containers
// never register it.
function withoutIterationListener(el) {
  const add = el.addEventListener;
  el.addEventListener = function (type, ...rest) {
    if (type === "animationiteration") return;
    return add.call(this, type, ...rest);
  };
  return el;
}

const rootEl = document.getElementById("root");
withoutIterationListener(rootEl);
withoutIterationListener(document.body);
// The app's hidden plugin-preview window loads this bundle too, but draws only
// the one plugin it is asked about (plugins/preview.jsx) — not the app.
if (location.hash === "#plugin-preview") {
  void import("./plugins/preview.jsx").then((m) => m.startPluginPreview());
} else {
  whenDaemonUp().then(async () => {
    holdUntilFirstPaint();
    // Before the first render, so built-in panels are there for restored tabs.
    startPlugins();
    // The first render draws what the boot snapshot holds (no request is made).
    await primeFromBoot();
    createRoot(rootEl).render(<App />);
    releaseAfterPaint();
  });
}
