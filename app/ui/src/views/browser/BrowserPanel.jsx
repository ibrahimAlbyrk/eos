import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { notify } from "../../lib/notify.js";
import {
  subscribe, getBrowserPanel, patchBrowserPanel, resetPanelView,
  browserFetch, withSession, refreshTabs, openTab, isBlankUrl,
  bindPaneSession, declareActiveTab,
} from "../../state/browserPanelStore.js";
import { notePanelOpened, seedRememberedTab } from "../../state/browserSessionState.js";
import { sessionRootOf } from "../../lib/agentIndex.js";
import { usePanelHost } from "../../state/panelHost.js";
import { useOriginPane } from "../../state/paneScope.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { BrowserEmptyState } from "./BrowserEmptyState.jsx";
import { BrowserTabStrip } from "./BrowserTabStrip.jsx";
import { BrowserNavBar } from "./BrowserNavBar.jsx";
import { BrowserModeButtons } from "./BrowserModeButtons.jsx";
import { AnnotationLayer } from "./AnnotationLayer.jsx";
import { PickerLayer } from "./PickerLayer.jsx";
import { useOcclusion } from "./useOcclusion.js";

// Browser docked panel. The page renders in a REAL embedded WebContentsView owned
// by the Electron main process — window.eosBrowserView is the narrow geometry/
// visibility bridge (the renderer never touches webContents). The daemon drives
// the SAME views for agents over /browser/host. There is no JPEG screencast /
// canvas path: the browser is desktop-app-only, so a non-app (web) client shows a
// message instead. Human verbs (open/close/navigate/device) flow renderer →
// daemon REST via browserPanelStore.

// Native embedded view present ⇒ the app owns rendering. Absent (web) ⇒ no browser.
const EMBEDDED = typeof window !== "undefined" && Boolean(window.eosBrowserView);

// Engine states that replace the view with a message body.
const LIVE_BLOCK = { disabled: "disabled", absent: "absent", crashed: "crashed" };

// The single side panel hosts ONE browser view, so its geometry key is a
// constant; the browser STATE (tabs/url) is still keyed per session, derived
// from the panel's `browser` data or the selected agent's session root. A Code
// view pane has no agent session, so it uses the global (human) browser.
const PANEL_ID = "sidepanel";

export function BrowserPanel() {
  const ui = useUi();
  const host = usePanelHost();
  const sessionKey = ui.panelData?.browser?.sessionKey ?? (host ? null : sessionRootOf(ui.selectedId));
  // Annotate/pick results go to the composer of the pane this panel lives in,
  // which listens on that pane's leaf id — not the constant geometry key.
  const composerPane = useOriginPane();
  // The panel stays mounted through its slide-out animation, but the native view
  // ignores DOM clipping — hide it the moment closing starts.
  const closing = !ui.showSidePanel;
  return <BrowserPanelInner paneId={PANEL_ID} sessionKey={sessionKey} composerPane={composerPane} closing={closing} />;
}

function BrowserPanelInner({ paneId, sessionKey, composerPane, closing }) {
  const panel = useSyncExternalStore(
    useCallback((cb) => subscribe(sessionKey, cb), [sessionKey]),
    useCallback(() => getBrowserPanel(sessionKey), [sessionKey]),
  );
  const [blocked, setBlocked] = useState(null);
  const [still, setStill] = useState(null); // { url, rect } standing in for the hidden live view
  const bodyRef = useRef(null);

  const activeTab = panel.tabs.find((t) => t.tabId === panel.activeTabId) ?? null;
  const live = LIVE_BLOCK[panel.engineState] ?? null;
  const block = blocked ?? live;
  const blank = !activeTab || isBlankUrl(activeTab.url);

  // Report the placeholder rect (window-content coordinates = CSS px = native
  // points on macOS) so main setBounds-es the view to track it.
  const reportBounds = useCallback(() => {
    const el = bodyRef.current;
    if (!el || !window.eosBrowserView) return;
    const r = el.getBoundingClientRect();
    window.eosBrowserView.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, []);

  useEffect(() => bindPaneSession(paneId, sessionKey), [paneId, sessionKey]);

  // Boot: only the embedded lane has a viewable browser. Ensure the engine is up
  // and a tab exists; the geometry effects then position the native view.
  useEffect(() => {
    if (!EMBEDDED) return;
    let cancelled = false;
    notePanelOpened(sessionKey);
    seedRememberedTab(sessionKey);
    patchBrowserPanel(sessionKey, { connState: "connecting" });
    (async () => {
      const status = await browserFetch(withSession(api.routes.browserStatus, sessionKey));
      if (cancelled) return;
      if (status.body?.state === "disabled" || status.status === 409) { setBlocked("disabled"); return; }
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
        await openTab(sessionKey);
        if (cancelled) return;
      }
      if (!getBrowserPanel(sessionKey).activeTabId) { setBlocked("error"); return; }
      patchBrowserPanel(sessionKey, { connState: "open" });
    })().catch((e) => {
      if (cancelled) return;
      setBlocked("error");
      notify.error(`Browser panel failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return () => {
      cancelled = true;
      // Reopening must start in live view: drop annotate/pick so an overlay never
      // remounts against a stale still, and clear any leftover overlay-hide.
      resetPanelView(sessionKey);
      patchBrowserPanel(sessionKey, { connState: "closed" });
      window.eosBrowserView.setVisible(false);
      window.eosBrowserView.overlayOpen(false);
      window.eosBrowserView.setOccluded?.(false);
    };
  }, [paneId, sessionKey]);

  // Position the native view over the placeholder and show it only when a real
  // page is loaded; hide it for the empty state, blocked states, or no tab.
  const showEmbedded = EMBEDDED && !block && !blank && !closing && Boolean(panel.activeTabId);
  useEffect(() => {
    if (!EMBEDDED) return;
    if (showEmbedded) {
      window.eosBrowserView.setActiveView({ sessionKey, tabId: panel.activeTabId });
      reportBounds();
      window.eosBrowserView.setVisible(true);
      // Keep the daemon's active-tab pointer in sync with what the human sees.
      void declareActiveTab(sessionKey, panel.activeTabId);
    } else {
      window.eosBrowserView.setVisible(false);
    }
  }, [showEmbedded, sessionKey, panel.activeTabId, reportBounds]);

  // A DOM layer over the body would sit under the native view: swap in a still of
  // the page (captured while still visible), then hide the live view until clear.
  const occluded = useOcclusion(bodyRef, showEmbedded);
  useEffect(() => {
    if (!EMBEDDED || !window.eosBrowserView.setOccluded) return;
    if (!occluded) {
      window.eosBrowserView.setOccluded(false);
      setStill(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const snap = await window.eosBrowserView.snapshot().catch(() => null);
      if (cancelled) return;
      setStill(snap);
      window.eosBrowserView.setOccluded(true);
    })();
    return () => { cancelled = true; };
  }, [occluded]);

  // Track the panel rect on resize + hide the native layer while the tab is hidden.
  useEffect(() => {
    if (!EMBEDDED) return;
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (showEmbedded) reportBounds(); });
    ro.observe(el);
    const onVisibility = () => window.eosBrowserView.setVisible(showEmbedded && !document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { ro.disconnect(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [showEmbedded, reportBounds]);

  return (
    <PanelShell
      type="browser"
      title={<BrowserTabStrip paneId={paneId} tabs={panel.tabs} activeTabId={panel.activeTabId} />}
      actions={<BrowserModeButtons paneId={paneId} mode={panel.mode} device={panel.device} />}
    >
      <BrowserNavBar paneId={paneId} tab={activeTab} urlDraft={panel.urlDraft} />
      <div className="browser-body" ref={bodyRef}>
        {!EMBEDDED && <div className="browser-empty">The browser panel is available in the Eos desktop app.</div>}
        {EMBEDDED && block === "disabled" && <div className="browser-empty">Browser subsystem is disabled — set <code>browser.enabled</code> in ~/.eos/config.json.</div>}
        {EMBEDDED && block === "absent" && <div className="browser-empty">Browser engine unavailable.</div>}
        {EMBEDDED && block === "crashed" && <div className="browser-empty">The browser stopped — reopen the panel to relaunch it.</div>}
        {EMBEDDED && block === "error" && <div className="browser-empty">Browser panel failed to start — see notifications.</div>}
        {EMBEDDED && !block && blank && <BrowserEmptyState />}
        {/* The native WebContentsView floats over this region; the body stays empty
            (React HTML cannot draw on top of a native layer). The annotate/pick
            overlays draw here once the native view is hidden (annotate) or picked
            (pick) via the eosBrowserView overlay channel. */}
        {EMBEDDED && !block && !blank && (
          <>
            <div className="browser-native-region" aria-hidden="true">
              {still && <StillFrame still={still} bodyRef={bodyRef} />}
            </div>
            {panel.mode === "annotate" && <AnnotationLayer paneId={paneId} sessionKey={sessionKey} composerPane={composerPane} tabId={panel.activeTabId} />}
            {panel.mode === "pick" && <PickerLayer paneId={paneId} composerPane={composerPane} tabId={panel.activeTabId} />}
          </>
        )}
      </div>
    </PanelShell>
  );
}

// The captured page, drawn exactly where the native view sat (main reports its
// window rect; the body is the positioned ancestor).
function StillFrame({ still, bodyRef }) {
  const body = bodyRef.current?.getBoundingClientRect();
  if (!body) return null;
  const { x, y, width, height } = still.rect;
  return (
    <img
      className="browser-still"
      src={still.url}
      alt=""
      draggable={false}
      style={{ left: x - body.left, top: y - body.top, width, height }}
    />
  );
}
