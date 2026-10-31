import { ipcRenderer } from "electron";

// The preload of artifact views (main/artifacts). In the hover peek the page is
// only a preview: a shield over it turns a click into "open" (⌥ → claude.ai)
// and keeps scrolls and clicks from the page. It lives in this isolated world
// and exposes nothing to the page; claude.ai's nonce CSP blocks inline style
// attributes but not CSSOM, so it is a closed shadow root styled through a
// constructable stylesheet. Clicks reach main only when the browser marks them
// trusted.

const CSS = ":host{all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;cursor:pointer !important}";

let peek = false;
let domReady = false;
let shield: HTMLElement | null = null;

function build(): HTMLElement {
  const host = document.createElement("eos-artifact-shield");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  host.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.isTrusted) ipcRenderer.send("artifactOverlay:action", ev.altKey ? "external" : "open");
  });
  host.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
  return host;
}

function render(): void {
  if (peek && domReady) {
    shield ??= build();
    if (!shield.isConnected && document.documentElement) document.documentElement.append(shield);
  } else {
    shield?.remove();
  }
}

ipcRenderer.on("artifactOverlay:set", (_e, next: unknown) => {
  peek = Boolean(next && typeof next === "object" && (next as Record<string, unknown>).peek === true);
  render();
});

function ready(): void {
  domReady = true;
  render();
  // A page that rebuilds <html>'s children (hydration) takes the shield with it.
  if (document.documentElement) new MutationObserver(render).observe(document.documentElement, { childList: true });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
else ready();
