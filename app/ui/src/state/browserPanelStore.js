// browserPanelStore — per-pane UI state for the browser panel, keyed by PANE
// id (a split layout runs independent panels). Module singleton in the
// ptyPanelStore shape (subscribe/getSnapshot/emit/_reset) consumed with
// useSyncExternalStore. Daemon state (the tabs themselves) is truth; this
// holds only what the panel chrome renders, plus the tab/navigation actions
// the chrome fires — the same split ptyPanelStore uses for PTY tabs.

import { api } from "../api/client.js";
import { notify } from "../lib/notify.js";

const EMPTY = {
  tabs: [],
  activeTabId: null,
  mode: "view", // "view" | "annotate" | "pick" — mutually exclusive
  device: "responsive", // the ACTIVE tab's emulated device, mirrored from deviceByTab
  deviceByTab: {}, // tabId -> "mobile" | "tablet" | "responsive"; emulation is per-tab
  deviceBusy: false, // a device switch is in flight (the daemon reloads the page)
  urlDraft: "",
  connState: "closed", // "connecting" | "open" | "closed"
  engineState: null, // BrowserEngineState from the browser:status SSE reason
};

const panes = new Map(); // paneId -> { state, snapshot, subs, lastUrl }

function paneOf(paneId) {
  let p = panes.get(paneId);
  if (!p) {
    // lastUrl: the active tab's url as of the last daemon read, so a page-driven
    // navigation can refresh the URL bar without clobbering what's being typed.
    p = { state: { ...EMPTY }, snapshot: EMPTY, subs: new Set(), lastUrl: "" };
    panes.set(paneId, p);
  }
  return p;
}

function emit(p) {
  p.snapshot = { ...p.state };
  for (const cb of p.subs) cb();
}

export function subscribe(paneId, cb) {
  const p = paneOf(paneId);
  p.subs.add(cb);
  return () => p.subs.delete(cb);
}

// Stable reference between emits — useSyncExternalStore contract.
export function getBrowserPanel(paneId) {
  return panes.get(paneId)?.snapshot ?? EMPTY;
}

export function patchBrowserPanel(paneId, partial) {
  const p = paneOf(paneId);
  p.state = { ...p.state, ...partial };
  emit(p);
}

// ---- daemon access --------------------------------------------------------
// The /browser routes are loopback + ui-token gated and api/client.js has no
// browser verbs, so every browser call (and the frame WS URL) goes through
// these two helpers.

const TOKEN = (typeof window !== "undefined" && window.__EOS_UI_TOKEN) || "";

export async function browserFetch(path, opts = {}) {
  const r = await fetch(`${api.daemon}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { "x-eos-ui-token": TOKEN } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, body };
}

export function browserStreamUrl() {
  const ws = api.daemon.replace(/^http/, "ws");
  return `${ws}/browser/stream?uiToken=${encodeURIComponent(TOKEN)}`;
}

function failed(r, what) {
  notify.error(`Browser ${what} failed: ${r.body?.error ?? r.status}`);
}

// ---- tabs -----------------------------------------------------------------

// The device emulated on a given tab; a tab the user never switched is Responsive.
function deviceFor(p, tabId) {
  return p.state.deviceByTab[tabId] ?? "responsive";
}

// about:blank (and "") is the empty new-tab state: the panel paints
// BrowserEmptyState instead of the canvas, and the address bar shows nothing
// (its placeholder) rather than the literal "about:blank".
const BLANK_URLS = new Set(["", "about:blank"]);
export function isBlankUrl(url) {
  return BLANK_URLS.has(url ?? "");
}
function displayUrl(url) {
  return isBlankUrl(url) ? "" : url;
}

function selectTab(paneId, tabId, url = "") {
  const p = paneOf(paneId);
  p.lastUrl = url;
  // device follows the tab: switching shows that tab's emulation, a fresh tab
  // (no map entry) shows Responsive.
  patchBrowserPanel(paneId, { activeTabId: tabId, urlDraft: displayUrl(url), device: deviceFor(p, tabId) });
}

// Mirror the daemon's tab list into a pane. The URL bar follows the active tab
// only when the PAGE moved it (a link click, a redirect) — a list that lands
// mid-typing leaves the draft alone.
function applyTabsToPane(p, tabs) {
  const activeTabId = tabs.some((t) => t.tabId === p.state.activeTabId)
    ? p.state.activeTabId
    : tabs[0]?.tabId ?? null;
  const url = tabs.find((t) => t.tabId === activeTabId)?.url ?? "";
  const patch = { tabs, activeTabId, device: deviceFor(p, activeTabId) };
  if (url !== p.lastUrl) patch.urlDraft = displayUrl(url);
  p.lastUrl = url;
  p.state = { ...p.state, ...patch };
  emit(p);
}

export async function refreshTabs(paneId) {
  const r = await browserFetch(api.routes.browserTabs);
  if (!r.ok || !Array.isArray(r.body?.tabs)) return null;
  applyTabsToPane(paneOf(paneId), r.body.tabs);
  return r.body.tabs;
}

// SSE browser:tabs — a tab opened/closed/navigated, or its title/favicon/audio
// changed. One daemon-wide event (Chrome is shared), so it lands in every pane
// that has a browser panel; each keeps its own active tab and URL draft.
export function applyTabs(tabs) {
  if (!Array.isArray(tabs)) return;
  for (const p of panes.values()) applyTabsToPane(p, tabs);
}

// SSE browser:status — engine lifecycle (launching/running/crashed/absent/
// disabled). Daemon-wide too, so the panel stops showing a frozen last frame
// when Chrome dies under it.
export function applyStatus(status) {
  const engineState = status?.state;
  if (!engineState) return;
  for (const p of panes.values()) {
    if (p.state.engineState === engineState) continue;
    p.state = { ...p.state, engineState };
    emit(p);
  }
}

export async function openTab(paneId, url) {
  const r = await browserFetch(api.routes.browserTabs, {
    method: "POST",
    body: JSON.stringify(url ? { url } : {}),
  });
  if (!r.ok || !r.body?.tabId) { failed(r, "tab open"); return null; }
  selectTab(paneId, r.body.tabId);
  await refreshTabs(paneId);
  return r.body.tabId;
}

// Close a tab: DELETE it, drop it, re-pick a neighbour if it was active. If it
// was the pane's LAST tab a fresh one opens immediately — the panel never shows
// zero tabs (the PTY panel's rule; the panel's own × is how you leave).
export async function closeTab(paneId, tabId) {
  const p = paneOf(paneId);
  const idx = p.state.tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return;
  const wasActive = p.state.activeTabId === tabId;
  const r = await browserFetch(api.routes.browserTab(tabId), { method: "DELETE" });
  if (!r.ok) { failed(r, "tab close"); return; }
  const rest = p.state.tabs.filter((t) => t.tabId !== tabId);
  patchBrowserPanel(paneId, { tabs: rest });
  if (rest.length === 0) {
    selectTab(paneId, null);
    await openTab(paneId);
    return;
  }
  if (wasActive) {
    const next = rest[Math.min(idx, rest.length - 1)];
    selectTab(paneId, next.tabId, next.url);
  }
  await refreshTabs(paneId);
}

// Per-tab audio. The daemon flips Chrome's tab-level mute; the UI never touches
// the page's volume (a zeroed volume can't be restored to the user's level), so
// only the boolean travels. `audible` is best-effort — a tab can be making sound
// the daemon hasn't noticed — so this works on any tab, lit indicator or not.
export async function setMuted(paneId, tabId, muted) {
  const r = await browserFetch(api.routes.browserMute(tabId), {
    method: "POST",
    body: JSON.stringify({ muted }),
  });
  if (!r.ok) { failed(r, muted ? "mute" : "unmute"); return; }
  await refreshTabs(paneId);
}

export function switchTab(paneId, tabId) {
  const p = paneOf(paneId);
  if (p.state.activeTabId === tabId) return;
  const tab = p.state.tabs.find((t) => t.tabId === tabId);
  if (!tab) return;
  selectTab(paneId, tabId, tab.url);
}

// ---- navigation -----------------------------------------------------------

// The URL bar takes what a browser address bar takes: an explicit scheme is
// left alone, anything else gets https://. A bare "localhost:3000" is a
// host:port, not a scheme — hence the "://" test rather than a bare colon.
const EXPLICIT_SCHEME = /^(about|blob|data|file|mailto|view-source|chrome):/i;

export function normalizeUrl(text) {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.includes("://") || EXPLICIT_SCHEME.test(t)) return t;
  return `https://${t}`;
}

// POST a BrowserNavigateRequest for the pane's active tab. action "url" carries
// the (normalized) address; back/forward/reload carry nothing.
export async function navigate(paneId, { action, url }) {
  const tabId = paneOf(paneId).state.activeTabId;
  if (!tabId) return;
  const body = { action };
  if (action === "url") {
    body.url = normalizeUrl(url);
    if (!body.url) return;
  }
  const r = await browserFetch(api.routes.browserNavigate(tabId), {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) { failed(r, "navigation"); return; }
  await refreshTabs(paneId);
}

export function setUrlDraft(paneId, urlDraft) {
  patchBrowserPanel(paneId, { urlDraft });
}

// ---- modes ----------------------------------------------------------------

// One enum field, so picking a mode always clears the other two; pressing the
// lit button returns to plain view.
export function toggleMode(paneId, mode) {
  const p = paneOf(paneId);
  patchBrowserPanel(paneId, { mode: p.state.mode === mode ? "view" : mode });
}

// Closing the panel (the mount effect's cleanup) drops the transient mode back
// to plain view, so a reopen always starts in live view — never resuming a
// half-finished annotate/pick against a stale frozen frame. The frozen frame,
// in-progress strokes and pending capture all live in the overlay components,
// so returning to "view" (which unmounts them) is the whole reset.
export function resetPanelView(paneId) {
  patchBrowserPanel(paneId, { mode: "view" });
}

// Device emulation is per-tab and real: the daemon applies CDP metrics + reloads
// so the page gets a genuine mobile/tablet DOM. The switch runs daemon-first —
// `device` (the menu's checkmark) only moves once the daemon confirms, so a
// refused switch never shows a device that is not actually in effect. deviceBusy
// covers the reload while the emulated frames arrive.
export async function setDevice(paneId, device) {
  const p = paneOf(paneId);
  const tabId = p.state.activeTabId;
  if (!tabId || deviceFor(p, tabId) === device) return;
  patchBrowserPanel(paneId, { deviceBusy: true });
  const r = await browserFetch(api.routes.browserDevice(tabId), {
    method: "POST",
    body: JSON.stringify({ device }),
  });
  const cur = paneOf(paneId);
  if (!r.ok) {
    failed(r, "device");
    patchBrowserPanel(paneId, { deviceBusy: false });
    return;
  }
  patchBrowserPanel(paneId, {
    deviceByTab: { ...cur.state.deviceByTab, [tabId]: device },
    // The active tab can change mid-flight; only move the visible selection when
    // we are still on the tab we switched.
    device: cur.state.activeTabId === tabId ? device : cur.state.device,
    deviceBusy: false,
  });
}

// Test-only: reset the module singleton between cases.
export function _resetBrowserPanel() {
  panes.clear();
}
