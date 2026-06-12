// The open page swaps bundles only when a ui:reload SSE arrives (eos build).
// `vite build --watch` rewrites dist silently, and a page disconnected during
// a build misses the reload — either way the app keeps running a stale bundle
// and "fixed" bugs stay reproducible on screen. Compare the served index's
// entry-bundle URL against the one this page loaded and reload once when they
// diverge.

const RELOADED_KEY = "cm:uiReloadedFor";

export function bundleSrcFromHtml(html) {
  return /<script[^>]*\bsrc="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html)?.[1] ?? null;
}

export async function checkUiFresh({
  getCurrentSrc = defaultGetCurrentSrc,
  fetchIndex = defaultFetchIndex,
  reload = () => window.location.reload(),
  storage = globalThis.sessionStorage,
} = {}) {
  const current = getCurrentSrc();
  if (!current) return false;
  const served = bundleSrcFromHtml((await fetchIndex()) ?? "");
  if (!served || served === current) return false;
  // One reload per target bundle — if the swap fails (cache, race with the
  // next build), don't reload-loop.
  if (storage.getItem(RELOADED_KEY) === served) return false;
  storage.setItem(RELOADED_KEY, served);
  reload();
  return true;
}

function defaultGetCurrentSrc() {
  return document.querySelector('script[src*="/assets/index-"]')?.getAttribute("src") ?? null;
}

async function defaultFetchIndex() {
  try {
    const r = await fetch("/web/", { cache: "no-store" });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
