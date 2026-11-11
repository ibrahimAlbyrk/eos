// Shell bridge for the dashboard. Served by the in-process handler as the first script of
// index.html, so every global exists before the app boots (what Electron's preload did).
// Every call is a same-origin request to /_shell/*: no Tauri IPC is exposed to the page.
(() => {
  const CFG = __CFG__;
  const TOKEN = CFG.uiToken;

  // One-time carry-over of the Electron profile's localStorage (origin eos://app).
  if (CFG.lsSeed) {
    try {
      if (!localStorage.getItem("eos:migratedFromElectron")) {
        let n = 0;
        for (const [k, v] of Object.entries(CFG.lsSeed)) { localStorage.setItem(k, v); n++; }
        localStorage.setItem("eos:migratedFromElectron", String(Date.now()));
        window.__eosSeeded = n;
      }
    } catch (e) { window.__eosSeedError = String(e); }
  }

  window.__EOS_DAEMON_URL = CFG.daemonUrl;
  window.__EOS_RAW_URL = CFG.rawUrl;
  window.__EOS_UI_TOKEN = TOKEN;

  const post = (path, body) =>
    fetch("/_shell/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eos-ui-token": TOKEN },
      body: JSON.stringify(body ?? null),
    }).then((r) => r.json()).then((j) => j.value ?? null, () => null);
  const send = (path, body) => { void post(path, body); };

  // Shell → page events: one EventSource, fanned out by name.
  const listeners = new Map();
  const on = (name, cb) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  };
  const es = new EventSource("/_shell/events?t=" + TOKEN);
  es.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      for (const cb of listeners.get(m.name) ?? []) cb(m.payload);
    } catch { /* malformed frame */ }
  };

  window.eosHosts = {
    list: () => post("hosts/list"),
    switchTo: (id) => send("hosts/switch", { id }),
    openInWindow: (id) => send("hosts/openWindow", { id }),
    reconnect: (id) => send("hosts/reconnect", { id }),
    requestConnect: () => send("hosts/requestConnect"),
    onChange: (cb) => on("hosts:changed", cb),
    onVisibility: (cb) => on("hosts:visibility", cb),
    onCommand: (cb) => on("hosts:command", cb),
  };

  // Geometry calls travel as independent requests, so each carries a sequence number
  // and the shell drops one that arrives after a newer one.
  let seq = 0;
  window.eosBrowserView = {
    setActiveView: (arg) => send("browserView/setActiveView", { sessionKey: arg?.sessionKey, tabId: arg?.tabId }),
    setBounds: (r) => send("browserView/setBounds", { seq: ++seq, x: r?.x, y: r?.y, width: r?.width, height: r?.height }),
    setVisible: (v) => send("browserView/setVisible", { value: !!v }),
    overlayOpen: (v) => send("browserView/overlay", { value: !!v }),
    setOccluded: (v) => send("browserView/occluded", { value: !!v }),
    snapshot: () => post("browserView/snapshot"),
    pickElement: (tabId) => post("browserView/pick", { tabId }),
    cancelPick: () => send("browserView/pickCancel"),
  };

  window.eosNotify = { show: (n) => send("notify", { title: n?.title, body: n?.body }) };

  const rect = (r) => ({ x: r?.x, y: r?.y, width: r?.width, height: r?.height });
  window.eosArtifacts = {
    warm: (ref) => send("artifacts/warm", { ref }),
    peek: (ref, r) => send("artifacts/peek", { ref, rect: rect(r) }),
    unpeek: () => send("artifacts/unpeek"),
    attach: (tabKey, ref, r) => send("artifacts/attach", { tabKey, ref, rect: rect(r) }),
    setBounds: (tabKey, r) => send("artifacts/setBounds", { tabKey, rect: rect(r) }),
    setVisible: (tabKey, visible) => send("artifacts/setVisible", { tabKey, visible }),
    detach: (tabKey) => send("artifacts/detach", { tabKey }),
    reload: (slug) => send("artifacts/reload", { slug }),
    still: (ref) => post("artifacts/still", { ref }),
    state: (slug) => post("artifacts/state", { slug }),
    onState: (cb) => on("artifacts:stateChanged", cb),
    onAction: (cb) => on("artifacts:action", cb),
    account: (loginId, expectedEmail) => post("artifacts/account", { loginId, expectedEmail }),
    signIn: (loginId, expectedEmail) => post("artifacts/signIn", { loginId, expectedEmail }),
    signOut: (loginId) => post("artifacts/signOut", { loginId }),
  };

  window.webkit = {
    messageHandlers: {
      themeChanged: { postMessage: (t) => send("theme/changed", { theme: t }) },
      themeSnapshot: { postMessage: () => send("theme/snapshot") },
      saveFile: { postMessage: (p) => send("saveFile", { filename: p?.filename, bytes: p?.base64?.length ?? 0 }) },
      pasteboardPaths: { postMessage: () => post("pasteboard/paths") },
      titlebarDrag: { postMessage: () => {} },
      titlebarDblClick: { postMessage: () => {} },
    },
  };

  const mark = () => {
    document.documentElement.classList.add("native");
    document.documentElement.dataset.os = "mac";
  };
  if (document.documentElement) mark();
  else document.addEventListener("DOMContentLoaded", mark, { once: true });

  // Window drag: the UI marks its title strips with `--app-region: drag` (inherited).
  // Electron mapped that to -webkit-app-region; here a mousedown on such an element asks
  // the shell to start a native drag. The transcript and the sidebar take no part.
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    if (e.target.closest(".messages-wrap, .side")) return;
    if (getComputedStyle(e.target).getPropertyValue("--app-region").trim() !== "drag") return;
    window.__eosDragAsked = (window.__eosDragAsked ?? 0) + 1;
    if (e.detail === 2) send("window/toggleMaximize");
    else send("window/startDragging");
  }, true);

  // First frame with the sidebar in the DOM = "UI ready" (same mark the Electron bench used).
  const tick = () => {
    if (document.querySelector(".side")) window.__eosReadyAt = performance.now();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
