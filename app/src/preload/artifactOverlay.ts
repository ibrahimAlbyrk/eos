import { ipcRenderer } from "electron";

// The floating toolbar inside an artifact view (main/artifacts). A native view
// paints above the dashboard's DOM, so the toolbar lives in the artifact page
// itself: this preload's isolated world draws it and exposes nothing to the
// page. claude.ai's nonce CSP blocks inline style attributes but not CSSOM, so
// it is a closed shadow root styled only through a constructable stylesheet.
// Clicks reach main only when the browser marks them trusted.

type Action = "reload" | "copy" | "all-artifacts" | "external" | "open";
interface Info { visible: boolean; peek: boolean; initial: string; account: string; meta: string }
interface Ui { bar: HTMLElement; who: HTMLElement; avatar: HTMLElement; account: HTMLElement; meta: HTMLElement; note: HTMLElement; divider: HTMLElement }

const SVG_NS = "http://www.w3.org/2000/svg";
const CLAUDE_HOSTS = new Set(["claude.ai", "preview.claude.ai"]);
const ARTIFACT_PATH = /^\/(?:artifact|code\/artifact|code\/frame)\//;
const SCROLL_REST_MS = 900;
const FLASH_MS = 1400;

const BUTTONS: Array<[Exclude<Action, "open">, string]> = [
  ["reload", "Reload"],
  ["copy", "Copy link"],
  ["all-artifacts", "All artifacts"],
  ["external", "Open on claude.ai"],
];

const ICONS: Record<Exclude<Action, "open">, Array<[string, Record<string, string>]>> = {
  reload: [["path", { d: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" }]],
  copy: [["path", { d: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" }]],
  "all-artifacts": [
    ["rect", { x: "2.5", y: "2.5", width: "4.5", height: "4.5", rx: "1" }],
    ["rect", { x: "9", y: "2.5", width: "4.5", height: "4.5", rx: "1" }],
    ["rect", { x: "2.5", y: "9", width: "4.5", height: "4.5", rx: "1" }],
    ["rect", { x: "9", y: "9", width: "4.5", height: "4.5", rx: "1" }],
  ],
  external: [["path", { d: "M9 3h4v4M13 3L7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" }]],
};

const CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 26px !important;
  z-index: 2147483647 !important;
  display: flex !important;
  justify-content: center !important;
  pointer-events: none !important;
}
[hidden] { display: none !important; }
.bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px;
  border-radius: 999px;
  background: rgba(32, 32, 32, .74);
  -webkit-backdrop-filter: blur(16px) saturate(1.8);
  backdrop-filter: blur(16px) saturate(1.8);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .16),
    inset 0 0 0 .5px rgba(255, 255, 255, .10),
    0 22px 50px -14px rgba(0, 0, 0, .7),
    0 6px 14px -4px rgba(0, 0, 0, .35);
  font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #e9e9e9;
  -webkit-font-smoothing: antialiased;
  -webkit-user-select: none;
  user-select: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(4px);
  transition: opacity .2s ease, transform .2s ease, visibility 0s linear .2s;
}
.bar.on {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition: opacity .2s ease, transform .2s ease, visibility 0s;
}
.bar.on.scrolling { opacity: 0; pointer-events: none; }
.who {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  max-width: 320px;
  padding: 0 10px 0 4px;
  white-space: nowrap;
}
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, .14);
  color: #f2f2f2;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  text-transform: uppercase;
}
.text { display: flex; gap: 6px; min-width: 0; overflow: hidden; }
.account { flex: none; color: #e9e9e9; }
.meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: #8c8c8c; }
.note { display: none; color: #e9e9e9; }
.who.flash .account, .who.flash .meta { display: none; }
.who.flash .note { display: inline; }
.divider {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: rgba(255, 255, 255, .12);
}
.btn {
  all: unset;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: #d4d4d4;
  cursor: default;
  transition: background-color .12s ease, color .12s ease;
}
.btn:hover { background: rgba(255, 255, 255, .08); color: #f2f2f2; }
.btn:active { background: rgba(255, 255, 255, .12); }
.btn:focus-visible { outline: 1.5px solid rgba(255, 255, 255, .4); outline-offset: -1.5px; }
svg {
  display: block;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
@media (prefers-reduced-motion: reduce) {
  .bar, .bar.on, .btn { transition: none; }
}
`;

let info: Info = { visible: false, peek: false, initial: "", account: "", meta: "" };
let ui: Ui | null = null;
let shield: HTMLElement | null = null;
let domReady = false;
let scrolling = false;
let flashing = false;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

function onArtifactPage(): boolean {
  return CLAUDE_HOSTS.has(location.hostname) && ARTIFACT_PATH.test(location.pathname);
}

function el(tag: string, cls: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

function icon(action: Exclude<Action, "open">): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of ICONS[action]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

function build(): Ui {
  const host = document.createElement("eos-artifact-toolbar");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];

  const bar = el("div", "bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Artifact");
  const who = el("div", "who");
  const avatar = el("span", "avatar");
  avatar.setAttribute("aria-hidden", "true");
  const text = el("span", "text");
  const account = el("span", "account");
  const meta = el("span", "meta");
  const note = el("span", "note");
  text.append(account, meta, note);
  who.append(avatar, text);
  const divider = el("span", "divider");
  bar.append(who, divider);
  for (const [action, label] of BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(icon(action));
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (ev.isTrusted) ipcRenderer.send("artifactOverlay:action", action);
    });
    bar.append(button);
  }
  root.append(bar);

  // A page that rebuilds <html>'s children (hydration) takes the toolbar with it.
  const attach = (): void => {
    if (!host.isConnected && document.documentElement) document.documentElement.append(host);
  };
  attach();
  if (document.documentElement) new MutationObserver(attach).observe(document.documentElement, { childList: true });

  return { bar, who, avatar, account, meta, note, divider };
}

// In the hover peek the page is a preview: a click opens the artifact (⌥ on
// claude.ai) and nothing reaches the page, not even a scroll.
function buildShield(): HTMLElement {
  const host = document.createElement("eos-artifact-shield");
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(":host{all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;cursor:pointer !important}");
  root.adoptedStyleSheets = [sheet];
  host.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.isTrusted) ipcRenderer.send("artifactOverlay:action", ev.altKey ? "external" : "open");
  });
  host.addEventListener("wheel", (ev) => ev.preventDefault(), { passive: false });
  return host;
}

function renderShield(): void {
  if (info.peek && domReady) {
    shield ??= buildShield();
    if (!shield.isConnected && document.documentElement) document.documentElement.append(shield);
  } else {
    shield?.remove();
  }
}

function render(): void {
  renderShield();
  const show = info.visible && onArtifactPage();
  if (!ui) {
    if (!show || !domReady) return;
    ui = build();
  }
  ui.bar.classList.toggle("on", show);
  ui.bar.classList.toggle("scrolling", show && scrolling);
  ui.avatar.textContent = info.initial;
  ui.avatar.hidden = !info.initial;
  ui.account.textContent = info.account;
  ui.account.hidden = !info.account;
  ui.meta.textContent = info.meta;
  ui.meta.hidden = !info.meta;
  ui.who.classList.toggle("flash", flashing);
  ui.who.hidden = !flashing && !info.initial && !info.account && !info.meta;
  ui.divider.hidden = ui.who.hidden;
}

function scrolled(): void {
  scrolling = true;
  render();
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    scrolling = false;
    render();
  }, SCROLL_REST_MS);
}

function flash(text: string): void {
  if (!ui) return;
  ui.note.textContent = text;
  flashing = true;
  render();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashing = false;
    render();
  }, FLASH_MS);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? Array.from(v).slice(0, max).join("") : "";
}

ipcRenderer.on("artifactOverlay:set", (_e, next: unknown) => {
  const n = next && typeof next === "object" ? (next as Record<string, unknown>) : {};
  info = {
    visible: n.visible === true,
    peek: n.peek === true,
    initial: text(n.initial, 2),
    account: text(n.account, 80),
    meta: text(n.meta, 120),
  };
  render();
});
ipcRenderer.on("artifactOverlay:flash", (_e, label: unknown) => flash(text(label, 40) || "Copied"));
// Scrolls inside the artifact's cross-origin frame never reach this document; main forwards them.
ipcRenderer.on("artifactOverlay:scroll", scrolled);
window.addEventListener("scroll", scrolled, { capture: true, passive: true });
window.addEventListener("popstate", render);

function ready(): void {
  domReady = true;
  render();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
else ready();
