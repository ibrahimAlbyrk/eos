import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { notify } from "../../lib/notify.js";
import {
  subscribe, getBrowserPanel, patchBrowserPanel, resetPanelView,
  browserFetch, browserStreamUrl, withSession, refreshTabs, openTab, isBlankUrl,
  bindPaneSession,
} from "../../state/browserPanelStore.js";
import { notePanelOpened, seedRememberedTab } from "../../state/browserSessionState.js";
import { sessionRootOf } from "../../lib/agentIndex.js";
import { findLeaf } from "../../lib/paneLayout.js";
import { PanelShell } from "../code/panes/PanelShell.jsx";
import { BrowserCanvas } from "./BrowserCanvas.jsx";
import { BrowserEmptyState } from "./BrowserEmptyState.jsx";
import { BrowserTabStrip } from "./BrowserTabStrip.jsx";
import { BrowserNavBar } from "./BrowserNavBar.jsx";
import { BrowserModeButtons } from "./BrowserModeButtons.jsx";
import { AnnotationLayer } from "./AnnotationLayer.jsx";
import { PickerLayer } from "./PickerLayer.jsx";
import { DeviceFrame } from "./DeviceFrame.jsx";

// Browser docked panel: the shell header carries the tab strip and the three
// mode buttons, a navigation row sits under it, and the body paints the live
// page. Owns the frame-WS lifecycle: ensure Chrome is up → ensure one tab →
// open ws://…/browser/stream → subscribe to the ACTIVE tab → hand the socket to
// BrowserCanvas. Frames ride the dedicated binary WS, never SSE; hiding the app
// pauses the stream (Page.stopScreencast daemon-side → ~0 cost while hidden).
//
// Tab metadata and engine lifecycle arrive on the browser:tabs / browser:status
// SSE reasons (useLive.js → browserPanelStore); this panel only fetches on its
// own actions, never on a timer.

// Engine states that replace the canvas with a message body.
const LIVE_BLOCK = { disabled: "disabled", absent: "absent", crashed: "crashed" };

export function BrowserPanel() {
  const ui = useUi();
  if (!ui.browserViewer) return <PanelShell type="browser" />;
  // The session whose browser this panel shows: carried on the panel slot data
  // by whoever opened it, else resolved from the pane's shown agent ("global"
  // for an empty pane).
  const sessionKey = ui.browserViewer.sessionKey
    ?? sessionRootOf(findLeaf(ui.tree, ui.paneId)?.agentId);
  return <BrowserPanelInner paneId={ui.paneId} sessionKey={sessionKey} />;
}

function BrowserPanelInner({ paneId, sessionKey }) {
  const panel = useSyncExternalStore(
    useCallback((cb) => subscribe(sessionKey, cb), [sessionKey]),
    useCallback(() => getBrowserPanel(sessionKey), [sessionKey]),
  );
  const [ws, setWs] = useState(null);
  const [viewport, setViewport] = useState(null);
  // "disabled" | "absent" | "error" | null — terminal boot states with a
  // message body instead of a canvas.
  const [blocked, setBlocked] = useState(null);
  const wsRef = useRef(null);
  const bodyRef = useRef(null);

  // The panel's live pixel size — the daemon streams the RESPONSIVE tab 1:1 with
  // this (native device px, no upscale blur) and emulates the viewport to match
  // (frame aspect = panel aspect, so it fills with no letterbox). Mobile/Tablet
  // ignore it daemon-side.
  const readDisplay = useCallback(() => {
    const el = bodyRef.current;
    return { cssWidth: el?.clientWidth ?? 0, cssHeight: el?.clientHeight ?? 0, dpr: window.devicePixelRatio || 1 };
  }, []);

  // While mounted, the chrome children (tab strip, nav bar, overlays) key the
  // store by this pane's id — alias it to the session entry.
  useEffect(() => bindPaneSession(paneId, sessionKey), [paneId, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    // The human is looking now: clear the unseen badge, latch the session's
    // panel memory open, and re-apply its remembered tab if the store is fresh.
    notePanelOpened(sessionKey);
    seedRememberedTab(sessionKey);
    patchBrowserPanel(sessionKey, { connState: "connecting" });
    (async () => {
      const status = await browserFetch(withSession(api.routes.browserStatus, sessionKey));
      if (cancelled) return;
      if (status.body?.state === "disabled" || status.status === 409) { setBlocked("disabled"); return; }
      if (status.body?.state === "absent") { setBlocked("absent"); return; }
      const launched = await browserFetch(api.routes.browserLaunch, { method: "POST", body: "{}" });
      if (cancelled) return;
      if (!launched.ok) {
        setBlocked(launched.status === 409 ? "disabled" : "error");
        if (launched.status !== 409) notify.error(`Browser launch failed: ${launched.body?.error ?? launched.status}`);
        return;
      }
      const tabs = await refreshTabs(sessionKey);
      if (cancelled) return;
      if (tabs && tabs.length === 0) {
        // A fresh tab opens BLANK (about:blank) — no auto-navigation to any
        // site; the empty state shows until the human types a URL.
        await openTab(sessionKey);
        if (cancelled) return;
      }
      if (!getBrowserPanel(sessionKey).activeTabId) { setBlocked("error"); return; }

      const socket = new WebSocket(browserStreamUrl());
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;
      socket.addEventListener("open", () => {
        patchBrowserPanel(sessionKey, { connState: "open" });
        setWs(socket);
      });
      socket.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "subscribed" && msg.viewport) setViewport(msg.viewport);
          if (msg.type === "error") notify.warning(`Browser stream: ${msg.message}`);
        } catch { /* not a control message */ }
      });
      socket.addEventListener("close", () => patchBrowserPanel(sessionKey, { connState: "closed" }));
    })().catch((e) => {
      if (cancelled) return;
      setBlocked("error");
      notify.error(`Browser panel failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return () => {
      cancelled = true;
      wsRef.current?.close();
      wsRef.current = null;
      // Reopening must start in live view: drop annotate/pick so the overlay
      // (and its frozen frame) never remounts over a not-yet-painted canvas.
      resetPanelView(sessionKey);
      patchBrowserPanel(sessionKey, { connState: "closed" });
    };
  }, [paneId, sessionKey]);

  // Only the subscribed tab streams, so switching tabs re-subscribes on the same
  // socket (the daemon stops the previous tab's screencast). A device switch also
  // re-subscribes: the daemon only re-sends the emulated viewport on subscribe,
  // so this is what refreshes `viewport` after emulation changes the page size —
  // without it the canvas aspect and canvas→page mapping would keep the old size.
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !panel.activeTabId) return;
    // sessionKey rides the subscribe for the daemon's per-session active-tab
    // bookkeeping (what the human is looking at IS the session's foreground).
    ws.send(JSON.stringify({ type: "subscribe", tabId: panel.activeTabId, sessionKey, ...readDisplay() }));
  }, [ws, panel.activeTabId, panel.device, sessionKey, readDisplay]);

  // Panel resized → report the new pixel size (debounced ~150ms so a drag does
  // not spam CDP). The daemon re-emulates the Responsive viewport and restarts
  // the stream at the new native resolution; a plain setTimeout debounce, never
  // a poll.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer = null;
    const ro = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", ...readDisplay() }));
        }
      }, 150);
    });
    ro.observe(el);
    return () => { if (timer) clearTimeout(timer); ro.disconnect(); };
  }, [readDisplay]);

  // App hidden → pause (daemon stops the screencast: 0 bytes, ~0 CPU); visible
  // again → resume. The WS stays open so resume is instant.
  useEffect(() => {
    const onVisibility = () => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: document.hidden ? "pause" : "resume" }));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const activeTab = panel.tabs.find((t) => t.tabId === panel.activeTabId) ?? null;
  // The boot probe decides the first body; after that browser:status keeps it
  // honest — Chrome dying under the panel must not leave a frozen last frame.
  const live = LIVE_BLOCK[panel.engineState] ?? null;
  const block = blocked ?? live;
  // A blank tab (about:blank, or none yet) shows the empty state instead of the
  // live canvas — a new tab does not auto-navigate; the human types a URL above,
  // and once a real page loads this flips false and the canvas takes over.
  const blank = !activeTab || isBlankUrl(activeTab.url);

  return (
    <PanelShell
      type="browser"
      title={<BrowserTabStrip paneId={paneId} tabs={panel.tabs} activeTabId={panel.activeTabId} />}
      actions={<BrowserModeButtons paneId={paneId} mode={panel.mode} device={panel.device} />}
    >
      <BrowserNavBar paneId={paneId} tab={activeTab} urlDraft={panel.urlDraft} />
      <div className="browser-body" ref={bodyRef}>
        {block === "disabled" && <div className="browser-empty">Browser subsystem is disabled — set <code>browser.enabled</code> in ~/.eos/config.json.</div>}
        {block === "absent" && <div className="browser-empty">No Chrome binary found. Install Google Chrome or set <code>browser.chromePath</code>.</div>}
        {block === "crashed" && <div className="browser-empty">Chrome stopped — reopen the panel to relaunch it.</div>}
        {block === "error" && <div className="browser-empty">Browser panel failed to start — see notifications.</div>}
        {!block && blank && <BrowserEmptyState />}
        {!block && !blank && panel.connState !== "open" && <div className="browser-empty">Connecting…</div>}
        {/* DeviceFrame letterboxes an emulated viewport (Mobile/Tablet) and is a
            pass-through for Responsive. The canvas and the mode overlays are its
            children so all three share the SAME emulated box — the picker/annotate
            coordinate translation stays correct under emulation. */}
        {!block && !blank && (
          <DeviceFrame device={panel.device} busy={panel.deviceBusy}>
            <BrowserCanvas ws={ws} viewport={viewport} fill={panel.device === "responsive"} />
            {panel.mode === "annotate" && (
              <AnnotationLayer paneId={paneId} tabId={panel.activeTabId} />
            )}
            {panel.mode === "pick" && (
              <PickerLayer paneId={paneId} tabId={panel.activeTabId} viewport={viewport} />
            )}
          </DeviceFrame>
        )}
      </div>
    </PanelShell>
  );
}
