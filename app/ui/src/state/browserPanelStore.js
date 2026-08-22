// browserPanelStore — UI state for the browser panel, keyed by SESSION
// (parent-chain root worker id, or "global" — wave 2 re-key from pane id: a
// session owns its browser, so two panes showing the same session share one
// entry). Module singleton in the ptyPanelStore shape
// (subscribe/getSnapshot/emit/_reset) consumed with useSyncExternalStore.
// Daemon state (the tabs themselves) is truth; this holds only what the panel
// chrome renders, plus the tab/navigation actions the chrome fires — the same
// split ptyPanelStore uses for PTY tabs.
//
// The chrome children (tab strip, nav bar, mode buttons, overlays) still pass
// their pane's leaf id — bindPaneSession aliases it to the pane's session so
// those components stay untouched (their paneId prop also keys genuinely
// pane-scoped things like the composer hand-off).

import { api } from "../api/client.js";
import { notify } from "../lib/notify.js";
import { GLOBAL_SESSION } from "../lib/agentIndex.js";

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

const sessions = new Map(); // sessionKey -> { state, snapshot, subs, lastUrl }

// paneId -> sessionKey, bound by BrowserPanel while mounted, so chrome children
// that key by their pane still land on the session entry. Leaf ids and worker
// ids live in disjoint namespaces, so an unbound key passes through unchanged.
const paneSessions = new Map();

export function bindPaneSession(paneId, sessionKey) {
  paneSessions.set(paneId, sessionKey);
  return () => {
    if (paneSessions.get(paneId) === sessionKey) paneSessions.delete(paneId);
  };
}

function keyOf(key) {
  return paneSessions.get(key) ?? key ?? GLOBAL_SESSION;
}

function sessionOf(key) {
  const k = keyOf(key);
  let p = sessions.get(k);
  if (!p) {
    // lastUrl: the active tab's url as of the last daemon read, so a page-driven
    // navigation can refresh the URL bar without clobbering what's being typed.
    p = { state: { ...EMPTY }, snapshot: EMPTY, subs: new Set(), lastUrl: "" };
    sessions.set(k, p);
  }
  return p;
}

function emit(p) {
  p.snapshot = { ...p.state };
  for (const cb of p.subs) cb();
}

export function subscribe(sessionKey, cb) {
  const p = sessionOf(sessionKey);
  p.subs.add(cb);
  return () => p.subs.delete(cb);
}

// Stable reference between emits — useSyncExternalStore contract.
export function getBrowserPanel(sessionKey) {
  return sessions.get(keyOf(sessionKey))?.snapshot ?? EMPTY;
}

export function patchBrowserPanel(sessionKey, partial) {
  const p = sessionOf(sessionKey);
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

// The panel always declares the session it shows (?session=) — the daemon
// resolves a human caller's session from this param (missing = "global", the
// wave-1 shared context) and fences per-tab routes on it.
export function withSession(path, sessionKey) {
  const k = keyOf(sessionKey);
  return `${path}${path.includes("?") ? "&" : "?"}session=${encodeURIComponent(k)}`;
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

function selectTab(sessionKey, tabId, url = "") {
  const p = sessionOf(sessionKey);
  p.lastUrl = url;
  // device follows the tab: switching shows that tab's emulation, a fresh tab
  // (no map entry) shows Responsive.
  patchBrowserPanel(sessionKey, { activeTabId: tabId, urlDraft: displayUrl(url), device: deviceFor(p, tabId) });
}

// Mirror the daemon's tab list into a session entry. The URL bar follows the
// active tab only when the PAGE moved it (a link click, a redirect) — a list
// that lands mid-typing leaves the draft alone.
function applyTabsToSession(p, tabs) {
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

export async function refreshTabs(sessionKey) {
  const r = await browserFetch(withSession(api.routes.browserTabs, sessionKey));
  if (!r.ok || !Array.isArray(r.body?.tabs)) return null;
  applyTabsToSession(sessionOf(sessionKey), r.body.tabs);
  return r.body.tabs;
}

// SSE browser:tabs — a tab opened/closed/navigated, or its title/favicon/audio
// changed. Routed by the payload's owning session (missing sessionId = a
// wave-1 daemon = the global session); other sessions' entries are untouched.
export function applyTabs(payload) {
  const tabs = payload?.tabs;
  if (!Array.isArray(tabs)) return;
  const p = sessions.get(payload.sessionId ?? GLOBAL_SESSION);
  if (p) applyTabsToSession(p, tabs);
}

// SSE browser:status — engine lifecycle (launching/running/crashed/absent/
// disabled). Engine-global, so it lands in every session entry — the panel
// stops showing a frozen last frame when Chrome dies under it.
export function applyStatus(status) {
  const engineState = status?.state;
  if (!engineState) return;
  for (const p of sessions.values()) {
    if (p.state.engineState === engineState) continue;
    p.state = { ...p.state, engineState };
    emit(p);
  }
}

export async function openTab(sessionKey, url) {
  const r = await browserFetch(withSession(api.routes.browserTabs, sessionKey), {
    method: "POST",
    body: JSON.stringify(url ? { url } : {}),
  });
  if (!r.ok || !r.body?.tabId) { failed(r, "tab open"); return null; }
  selectTab(sessionKey, r.body.tabId);
  await refreshTabs(sessionKey);
  return r.body.tabId;
}

// Close a tab: DELETE it, drop it, re-pick a neighbour if it was active. If it
// was the session's LAST tab a fresh one opens immediately — the panel never
// shows zero tabs (the PTY panel's rule; the panel's own × is how you leave).
export async function closeTab(sessionKey, tabId) {
  const p = sessionOf(sessionKey);
  const idx = p.state.tabs.findIndex((t) => t.tabId === tabId);
  if (idx < 0) return;
  const wasActive = p.state.activeTabId === tabId;
  const r = await browserFetch(withSession(api.routes.browserTab(tabId), sessionKey), { method: "DELETE" });
  if (!r.ok) { failed(r, "tab close"); return; }
  const rest = p.state.tabs.filter((t) => t.tabId !== tabId);
  patchBrowserPanel(sessionKey, { tabs: rest });
  if (rest.length === 0) {
    selectTab(sessionKey, null);
    await openTab(sessionKey);
    return;
  }
  if (wasActive) {
    const next = rest[Math.min(idx, rest.length - 1)];
    selectTab(sessionKey, next.tabId, next.url);
  }
  await refreshTabs(sessionKey);
}

// Per-tab audio. The daemon flips Chrome's tab-level mute; the UI never touches
// the page's volume (a zeroed volume can't be restored to the user's level), so
// only the boolean travels. `audible` is best-effort — a tab can be making sound
// the daemon hasn't noticed — so this works on any tab, lit indicator or not.
export async function setMuted(sessionKey, tabId, muted) {
  const r = await browserFetch(withSession(api.routes.browserMute(tabId), sessionKey), {
    method: "POST",
    body: JSON.stringify({ muted }),
  });
  if (!r.ok) { failed(r, muted ? "mute" : "unmute"); return; }
  await refreshTabs(sessionKey);
}

export function switchTab(sessionKey, tabId) {
  const p = sessionOf(sessionKey);
  if (p.state.activeTabId === tabId) return;
  const tab = p.state.tabs.find((t) => t.tabId === tabId);
  if (!tab) return;
  selectTab(sessionKey, tabId, tab.url);
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

// POST a BrowserNavigateRequest for the session's active tab. action "url"
// carries the (normalized) address; back/forward/reload carry nothing.
export async function navigate(sessionKey, { action, url }) {
  const tabId = sessionOf(sessionKey).state.activeTabId;
  if (!tabId) return;
  const body = { action };
  if (action === "url") {
    body.url = normalizeUrl(url);
    if (!body.url) return;
  }
  const r = await browserFetch(withSession(api.routes.browserNavigate(tabId), sessionKey), {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) { failed(r, "navigation"); return; }
  await refreshTabs(sessionKey);
}

export function setUrlDraft(sessionKey, urlDraft) {
  patchBrowserPanel(sessionKey, { urlDraft });
}

// ---- modes ----------------------------------------------------------------

// One enum field, so picking a mode always clears the other two; pressing the
// lit button returns to plain view.
export function toggleMode(sessionKey, mode) {
  const p = sessionOf(sessionKey);
  patchBrowserPanel(sessionKey, { mode: p.state.mode === mode ? "view" : mode });
}

// Closing the panel (the mount effect's cleanup) drops the transient mode back
// to plain view, so a reopen always starts in live view — never resuming a
// half-finished annotate/pick against a stale frozen frame. The frozen frame,
// in-progress strokes and pending capture all live in the overlay components,
// so returning to "view" (which unmounts them) is the whole reset.
export function resetPanelView(sessionKey) {
  patchBrowserPanel(sessionKey, { mode: "view" });
}

// Device emulation is per-tab and real: the daemon applies CDP metrics + reloads
// so the page gets a genuine mobile/tablet DOM. The switch runs daemon-first —
// `device` (the menu's checkmark) only moves once the daemon confirms, so a
// refused switch never shows a device that is not actually in effect. deviceBusy
// covers the reload while the emulated frames arrive.
export async function setDevice(sessionKey, device) {
  const p = sessionOf(sessionKey);
  const tabId = p.state.activeTabId;
  if (!tabId || deviceFor(p, tabId) === device) return;
  patchBrowserPanel(sessionKey, { deviceBusy: true });
  const r = await browserFetch(withSession(api.routes.browserDevice(tabId), sessionKey), {
    method: "POST",
    body: JSON.stringify({ device }),
  });
  const cur = sessionOf(sessionKey);
  if (!r.ok) {
    failed(r, "device");
    patchBrowserPanel(sessionKey, { deviceBusy: false });
    return;
  }
  patchBrowserPanel(sessionKey, {
    deviceByTab: { ...cur.state.deviceByTab, [tabId]: device },
    // The active tab can change mid-flight; only move the visible selection when
    // we are still on the tab we switched.
    device: cur.state.activeTabId === tabId ? device : cur.state.device,
    deviceBusy: false,
  });
}

// Test-only: reset the module singleton between cases.
export function _resetBrowserPanel() {
  sessions.clear();
  paneSessions.clear();
}
