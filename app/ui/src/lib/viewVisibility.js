// Whether this dashboard is on screen. `document.hidden` covers a hidden window;
// a view of another computer also hears from the app shell, which detaches it
// while another machine is shown — Chromium still reports that view as visible.
//
// `document` is read off globalThis so the store-level unit tests (node env,
// no DOM) keep working.

let shellHidden = false;
const shellSubs = new Set();
let shellWired = false;

function wireShell() {
  if (shellWired) return;
  shellWired = true;
  const hosts = typeof window !== "undefined" ? window.eosHosts : null;
  hosts?.onVisibility?.((visible) => {
    if (shellHidden === !visible) return;
    shellHidden = !visible;
    for (const cb of shellSubs) cb();
  });
}

export function isViewHidden() {
  return shellHidden || globalThis.document?.hidden === true;
}

export function onViewVisibilityChange(cb) {
  wireShell();
  const doc = globalThis.document;
  doc?.addEventListener("visibilitychange", cb);
  shellSubs.add(cb);
  return () => {
    doc?.removeEventListener("visibilitychange", cb);
    shellSubs.delete(cb);
  };
}
