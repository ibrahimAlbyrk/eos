import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { getBrowserPanel, openTab, queueUrl } from "../../state/browserPanelStore.js";
import { createPage } from "../../state/pagesStore.js";
import { pageTabId, viewTabId } from "../../lib/panelTabs.js";
import { notify } from "../../lib/notify.js";
import { useBrowserSessionKey } from "../../views/browser/useBrowserSessionKey.js";
import { usePageScope } from "../../views/pages/usePageScope.js";
import { APP_ALLOW, APP_CSP, APP_SANDBOX, buildSrcdoc } from "./srcdoc.js";
import {
  DEFAULT_APP_HEIGHT, RPC_ERRORS, buildHostContext, clampInlineHeight,
  routeAppMessage, rpcError, rpcNotification, rpcResult,
} from "./bridge.js";
import { isAlwaysSend, setAlwaysSend } from "./trust.js";
import { appPageBody } from "./pageExport.js";
import { ConfirmChip } from "./ConfirmChip.jsx";
import "./apps.css";

// The App tier (present_app): agent-authored HTML/JS in a sandboxed srcdoc
// frame inside Eos chrome — the pill, reload / side panel /
// fullscreen, the confirmation chip for anything the app wants to tell the
// agent, and "Save as page". The app has no network and no way to reach Eos
// except the bridge (bridge.js), which answers only this frame's own window.
//
// Props: viewId, title, html, height (the app's declared px, optional),
// summary, onSend(text). Optional: onOpenLink(url) and onOpenPanel() override
// the defaults (Eos browser panel / the view's side-panel tab); project (the
// chat's folder, where "Save as page" files the page — else derived from live);
// mode "inline" | "panel"; pending (still being written — no frame yet).

const svg = (children, size = 14) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const LOCK = svg(<><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>, 12);
const RELOAD = svg(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);
const PANEL = svg(<><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></>);
const EXPAND = svg(<><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" x2="14" y1="3" y2="10" /><line x1="3" x2="10" y1="21" y2="14" /></>);
const SHRINK = svg(<><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" x2="21" y1="10" y2="3" /><line x1="3" x2="10" y1="21" y2="14" /></>);

const errText = (e) => (e instanceof Error ? e.message : String(e));

function freshBridge() {
  return { lastMessageAt: -Infinity, lastLinkAt: -Infinity, awaiting: null, initialized: false };
}

// A new window in the frame: its handshake and pending question start over;
// the rate clocks carry on, so reloading can't reset them.
function restarted(b) {
  return { ...freshBridge(), lastMessageAt: b.lastMessageAt, lastLinkAt: b.lastLinkAt };
}

// The app's declared height (a number, or a numeric string from a loose
// caller), or null when it sizes itself.
function declaredHeight(height) {
  if (typeof height === "number") return Number.isFinite(height) ? height : null;
  if (typeof height === "string" && height.trim() !== "") {
    const n = Number(height);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function AppFrame({
  viewId, title, html, height, summary, onSend,
  onOpenLink, onOpenPanel, live = null, project = null, mode = "inline", pending = false,
}) {
  const ui = useUi();
  const browserKey = useBrowserSessionKey();
  const pageScope = usePageScope(live);

  const declared = declaredHeight(height);
  const [frameHeight, setFrameHeight] = useState(() => clampInlineHeight(declared ?? DEFAULT_APP_HEIGHT));
  const [generation, setGeneration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [ask, setAsk] = useState(null); // { id, text } — a ui/message waiting for the user
  const [always, setAlways] = useState(() => isAlwaysSend(viewId));
  const [saved, setSaved] = useState({ state: "idle", pageId: null });

  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const frameRef = useRef(null);
  const bridge = useRef(freshBridge());

  const srcdoc = useMemo(() => buildSrcdoc(html ?? "", { autoResize: declared == null }), [html, declared]);
  const panel = mode === "panel";
  const filled = fullscreen || panel;
  const displayMode = fullscreen ? "fullscreen" : "inline";

  const post = useCallback((message) => {
    try {
      frameRef.current?.contentWindow?.postMessage(message, "*");
    } catch {
      // the frame went away mid-answer
    }
  }, []);

  const openLink = useCallback((url) => {
    if (onOpenLink) { onOpenLink(url); return; }
    if (getBrowserPanel(browserKey).connState === "open") void openTab(browserKey, url);
    else queueUrl(browserKey, url);
    ui.openPanel("browser");
  }, [onOpenLink, browserKey, ui]);

  const hostContext = useCallback(() => {
    const stage = stageRef.current;
    const fixed = filled || declared != null;
    return buildHostContext({
      displayMode,
      width: stage?.clientWidth ?? null,
      height: filled ? stage?.clientHeight ?? null : frameHeight,
      fixed,
    });
  }, [displayMode, filled, declared, frameHeight]);

  // The long-lived listener reads the current render through this ref.
  const latest = useRef(null);
  latest.current = { onSend, openLink, always, hostContext };

  // Hand the text to the agent and answer the app's ui/message once it is
  // through. onSend may be sync, return a promise, or resolve to the API
  // client's { ok, body } shape.
  const deliver = useCallback((id, text) => {
    let sent;
    try {
      sent = Promise.resolve(latest.current.onSend(text));
    } catch (e) {
      sent = Promise.reject(e);
    }
    const fail = (why) => post(rpcError(id, RPC_ERRORS.denied, `Message could not be sent: ${why}`));
    sent.then(
      (r) => (r && typeof r === "object" && r.ok === false ? fail(r.body?.error ?? `status ${r.status ?? "unknown"}`) : post(rpcResult(id))),
      (e) => fail(errText(e)),
    );
  }, [post]);

  useEffect(() => {
    setAlways(isAlwaysSend(viewId));
  }, [viewId]);

  // The spec can settle after the first render (a streamed call gets its height
  // and html at the end): start from the declared height again.
  useEffect(() => {
    setFrameHeight(clampInlineHeight(declared ?? DEFAULT_APP_HEIGHT));
  }, [declared]);

  useEffect(() => {
    bridge.current = restarted(bridge.current);
    setAsk(null);
  }, [srcdoc]);

  useEffect(() => {
    const onMessage = (event) => {
      const l = latest.current;
      const b = bridge.current;
      const now = Date.now();
      const effect = routeAppMessage(event, {
        frameWindow: frameRef.current?.contentWindow ?? null,
        now,
        lastMessageAt: b.lastMessageAt,
        lastLinkAt: b.lastLinkAt,
        awaitingUser: b.awaiting != null,
        alwaysSend: l.always,
        canSend: typeof l.onSend === "function",
        hostContext: l.hostContext,
      });
      if (effect.stamp === "message") b.lastMessageAt = now;
      if (effect.stamp === "link") b.lastLinkAt = now;
      switch (effect.type) {
        case "reply":
          if (effect.initialized) b.initialized = true;
          post(effect.message);
          break;
        case "resize":
          setFrameHeight(effect.height);
          if (effect.reply) post(effect.reply);
          break;
        case "open-link":
          l.openLink(effect.url);
          post(rpcResult(effect.id));
          break;
        case "send":
          deliver(effect.id, effect.text);
          break;
        case "confirm":
          b.awaiting = effect.id;
          setAsk({ id: effect.id, text: effect.text, kind: "send" });
          break;
        case "confirm-link":
          b.awaiting = effect.id;
          setAsk({ id: effect.id, text: effect.url, kind: "link" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, deliver]);

  // Tell a running app when it moves between inline, the panel and fullscreen.
  useEffect(() => {
    if (!bridge.current.initialized) return;
    const ctx = hostContext();
    post(rpcNotification("ui/notifications/host-context-changed", { displayMode: ctx.displayMode, containerDimensions: ctx.containerDimensions }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode, panel]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement != null && document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const settleAsk = () => {
    bridge.current.awaiting = null;
    setAsk(null);
  };
  const sendAsked = () => {
    if (!ask) return;
    settleAsk();
    if (ask.kind === "link") {
      latest.current.openLink(ask.text);
      post(rpcResult(ask.id));
    } else {
      deliver(ask.id, ask.text);
    }
  };
  const dismissAsked = () => {
    if (!ask) return;
    settleAsk();
    post(rpcError(ask.id, RPC_ERRORS.denied, ask.kind === "link" ? "Opening the link was denied" : "Message sending denied"));
  };
  const alwaysAsked = () => {
    setAlwaysSend(viewId, true);
    setAlways(true);
    sendAsked();
  };
  const askAgain = () => {
    setAlwaysSend(viewId, false);
    setAlways(false);
  };

  const reload = () => {
    bridge.current = restarted(bridge.current);
    setAsk(null);
    setFrameHeight(clampInlineHeight(declared ?? DEFAULT_APP_HEIGHT));
    setGeneration((g) => g + 1);
  };

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    try {
      const p = document.fullscreenElement === el ? document.exitFullscreen?.() : el.requestFullscreen?.();
      p?.catch?.((e) => notify.warning(`Couldn't change fullscreen: ${errText(e)}`));
    } catch (e) {
      notify.warning(`Couldn't change fullscreen: ${errText(e)}`);
    }
  };

  const openPanel = () => {
    if (onOpenPanel) onOpenPanel();
    else if (viewId) ui.openPanel(viewTabId(viewId));
  };

  const saveAsPage = async () => {
    if (saved.state === "saving") return;
    if (saved.state === "saved" && saved.pageId) { ui.openPanel(pageTabId(saved.pageId)); return; }
    setSaved({ state: "saving", pageId: null });
    try {
      const page = await createPage({
        title: title || "App",
        body: appPageBody({ summary, html }),
        project: project ?? pageScope.project ?? null,
        agentId: pageScope.agentId ?? null,
      });
      setSaved({ state: "saved", pageId: page.id });
      ui.openPanel(pageTabId(page.id));
    } catch (e) {
      setSaved({ state: "idle", pageId: null });
      notify.error(`Couldn't save the app as a page: ${errText(e)}`);
    }
  };

  const hasSource = typeof html === "string" && html.trim() !== "";
  const runnable = !pending && hasSource;
  const className = ["gv-app", panel && "is-panel", fullscreen && "is-fullscreen", filled && "is-filled"].filter(Boolean).join(" ");

  return (
    <section ref={rootRef} className={className} aria-label={title ? `App: ${title}` : "App"}>
      <header className="gv-app-head">
        <span className="gv-app-pill">{LOCK}APP · SANDBOXED</span>
        <span className="gv-app-title" title={title}>{title || "App"}</span>
        <span className="gv-app-tools">
          <button type="button" className="gv-app-icon" aria-label="Reload app" title="Reload"
            disabled={!runnable} onClick={reload}>{RELOAD}</button>
          {!panel && (viewId || onOpenPanel) ? (
            <button type="button" className="gv-app-icon" aria-label="Open in side panel" title="Open in side panel"
              onClick={openPanel}>{PANEL}</button>
          ) : null}
          <button type="button" className="gv-app-icon" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"} aria-pressed={fullscreen}
            disabled={!runnable} onClick={toggleFullscreen}>{fullscreen ? SHRINK : EXPAND}</button>
        </span>
      </header>

      <div ref={stageRef} className="gv-app-stage" style={filled ? undefined : { height: frameHeight }}>
        {runnable ? (
          <iframe
            key={generation}
            ref={frameRef}
            className="gv-app-frame"
            title={title || "App"}
            sandbox={APP_SANDBOX}
            allow={APP_ALLOW}
            csp={APP_CSP}
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={srcdoc}
          />
        ) : pending ? (
          <div className="gv-app-skeleton" role="status">Building the app…</div>
        ) : (
          <div className="gv-app-empty">{summary || "This app has no content."}</div>
        )}
      </div>

      {ask ? (
        <ConfirmChip key={ask.id} kind={ask.kind} text={ask.text} onSend={sendAsked} onDismiss={dismissAsked} onAlways={alwaysAsked} />
      ) : null}

      <footer className="gv-app-foot">
        <span className="gv-app-note">
          {always ? "Runs in an isolated sandbox · no network" : "Runs in an isolated sandbox · no network · sends nothing without your OK"}
        </span>
        {always ? (
          <button type="button" className="gv-app-trust" onClick={askAgain} title="Messages and links from this app go through without asking">
            Sends without asking · Ask again
          </button>
        ) : null}
        <button type="button" className="gv-app-btn gv-app-save" disabled={!hasSource || saved.state === "saving"} onClick={saveAsPage}>
          {saved.state === "saving" ? "Saving…" : saved.state === "saved" ? "Open page" : "Save as page"}
        </button>
      </footer>
    </section>
  );
}
