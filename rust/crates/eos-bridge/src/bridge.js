// The shell's bridge for the dashboard. It is inlined into the entry document as the first
// script, so every global exists before the app boots (what Electron's preload did).
// Every call is a same-origin request to /_shell/*; no page has native IPC.
(() => {
  const CFG = __CFG__;
  const TOKEN = CFG.uiToken;

  // One-time carry-over of the Electron profile's localStorage (origin eos://app), before
  // any dashboard code reads it. The shell stops offering the keys once told.
  let carried = null;
  if (CFG.seed) {
    try {
      if (localStorage.getItem(CFG.seedMarker)) carried = 0;
      else {
        let n = 0;
        for (const [k, v] of Object.entries(CFG.seed)) { localStorage.setItem(k, v); n++; }
        localStorage.setItem(CFG.seedMarker, String(Date.now()));
        carried = n;
      }
    } catch { /* storage unavailable: the shell offers the keys again next launch */ }
  }

  window.__EOS_DAEMON_URL = CFG.coreUrl;
  window.__EOS_RAW_URL = CFG.rawUrl;
  window.__EOS_UI_TOKEN = TOKEN;

  const post = (path, body) =>
    fetch("/_shell/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eos-ui-token": TOKEN },
      body: JSON.stringify(body ?? null),
    }).then((r) => r.json()).then((j) => j.value ?? null, () => null);
  const send = (path, body) => { void post(path, body); };

  if (carried != null) send("migration/done", { keys: carried });

  // Shell → page events: one EventSource, fanned out by name. An event that arrives before
  // the dashboard registered its listener (a link that launched the app) waits for it.
  const listeners = new Map();
  const early = new Map();
  const deliver = (cb, payload) => {
    try { cb(payload); } catch { /* one listener must not stop the others */ }
  };
  const on = (name, cb) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
    for (const payload of early.get(name) ?? []) deliver(cb, payload);
    early.delete(name);
    return () => set.delete(cb);
  };
  const events = new EventSource("/_shell/events?t=" + encodeURIComponent(TOKEN));
  events.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const set = listeners.get(m.name);
    if (set && set.size) {
      for (const cb of set) deliver(cb, m.payload);
    } else {
      const waiting = early.get(m.name) ?? [];
      if (waiting.length < 8) waiting.push(m.payload);
      early.set(m.name, waiting);
    }
  };

  // ---- the machine switcher. Views of other computers come in a later phase: the list is
  // empty and switching does nothing; the menu's "Connect a Machine…" still reaches the UI.
  window.eosHosts = {
    list: () => post("hosts/list"),
    switchTo: () => {},
    openInWindow: () => {},
    reconnect: () => {},
    requestConnect: () => {},
    onChange: (cb) => on("hosts:changed", cb),
    onVisibility: (cb) => on("hosts:visibility", cb),
    onCommand: (cb) => on("hosts:command", cb),
  };

  // ---- the browser panel: geometry and visibility only. Each report is its own request,
  // so each carries a sequence number and the shell drops one that arrives after a newer
  // one. Starting from the clock keeps the order across a reload of this page.
  let seq = Date.now();
  window.eosBrowserView = {
    setActiveView: (arg) => send("browserView/setActiveView", { seq: ++seq, sessionKey: arg?.sessionKey, tabId: arg?.tabId }),
    setBounds: (r) => send("browserView/setBounds", { seq: ++seq, x: r?.x, y: r?.y, width: r?.width, height: r?.height }),
    setVisible: (v) => send("browserView/setVisible", { seq: ++seq, value: !!v }),
    overlayOpen: (v) => send("browserView/overlay", { seq: ++seq, value: !!v }),
    setOccluded: (v) => send("browserView/occluded", { seq: ++seq, value: !!v }),
    snapshot: () => post("browserView/snapshot"),
    pickElement: (tabId) => post("browserView/pick", { tabId }),
    cancelPick: () => send("browserView/pickCancel"),
  };

  // ---- native banner for the dashboard's own errors and warnings (lib/notify.js).
  window.eosNotify = { show: (n) => send("notify", { title: n?.title, body: n?.body }) };

  // A click on a banner leads to a worker's chat or a named view.
  on("navigate", (p) => {
    if (p?.route) window.__nativeOpenRoute && window.__nativeOpenRoute(p.route);
    else if (p?.workerId) window.__nativeNavigate && window.__nativeNavigate(p.workerId);
  });

  // ---- window.webkit.messageHandlers: the names the dashboard's capability checks know.
  window.webkit = {
    messageHandlers: {
      themeChanged: { postMessage: (t) => send("theme/changed", { theme: t }) },
      // Freezes the current frame; the dashboard crossfades from it to the new theme.
      themeSnapshot: {
        postMessage: () => {
          void post("theme/snapshot").then((url) => window.__eosThemeSnapshot && window.__eosThemeSnapshot(url ?? null));
        },
      },
      saveFile: { postMessage: (p) => send("files/save", { filename: p?.filename, base64: p?.base64 }) },
      pasteboardPaths: { postMessage: () => post("clipboard/paths").then((v) => v ?? []) },
      titlebarDrag: { postMessage: () => {} },
      titlebarDblClick: { postMessage: () => {} },
    },
  };

  // ---- html.native gates the title-bar insets; data-os carries the desktop conventions.
  const mark = () => {
    document.documentElement.classList.add("native");
    document.documentElement.dataset.os = "mac";
  };
  if (document.documentElement) mark();
  else document.addEventListener("DOMContentLoaded", mark, { once: true });
  on("window:fullscreen", (p) => document.documentElement?.classList.toggle("fullscreen", !!p?.on));

  // ---- window drag. The dashboard marks its title strips with `--app-region: drag`
  // (inherited, `no-drag` on controls). A press on such an element asks the shell to start
  // a native drag; a double click zooms. The transcript and the sidebar take no part.
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest(".messages-wrap, .side")) return;
    if (getComputedStyle(e.target).getPropertyValue("--app-region").trim() !== "drag") return;
    if (e.detail === 2) send("window/toggleZoom");
    else if (e.detail === 1) send("window/startDragging");
  }, true);

  // ---- the system's own context menu never opens; the dashboard draws its own.
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

  // ---- files dropped from the Finder: the page only sees File objects, the shell reads
  // their real paths from the objects parked here.
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
  document.addEventListener("dragenter", (e) => { if (hasFiles(e)) e.preventDefault(); }, true);
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); }, true);
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    window.__eosDroppedFiles = Array.from(e.dataTransfer.files ?? []);
    void post("files/dropped").then((entries) => {
      window.__eosDroppedFiles = null;
      window.__eosNativeDrop && window.__eosNativeDrop(entries ?? []);
    });
  }, true);

  // ---- the Edit menu. Undo and redo belong to the composer's own stack; a focused
  // terminal copies its selection and takes pasted text itself; everything else is the
  // native command on this page.
  const term = () => window.__eosTerm;
  const native = (command) => send("edit", { command });
  const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const edit = async (command) => {
    switch (command) {
      case "undo": return window.__eosUndo ? window.__eosUndo() : native(command);
      case "redo": return window.__eosRedo ? window.__eosRedo() : native(command);
      case "copy":
      case "cut": {
        // The terminal is read-only, so cut is copy there.
        const selection = term()?.getSelectionIfFocused?.() ?? null;
        return typeof selection === "string" ? send("clipboard/write", { text: selection }) : native(command);
      }
      case "paste": {
        if (term()?.isFocused?.() === true) {
          const clip = await post("clipboard/read");
          // Images and Finder files take the page's own paste event even in a terminal.
          if (clip && !clip.hasFiles) return term().pasteBase64(toBase64(clip.text ?? ""));
        }
        return native(command);
      }
      case "selectAll": return term()?.isFocused?.() === true ? term().selectAll() : native(command);
    }
  };
  on("edit", (p) => { void edit(p?.command); });

  // ---- "ready": the sidebar is in the DOM. A timer, not a frame callback: a window that is
  // covered or hidden draws no frames.
  const ready = setInterval(() => {
    if (!document.querySelector(".side")) return;
    clearInterval(ready);
    send("ready", { ms: Math.round(performance.now()) });
  }, 50);
})();
