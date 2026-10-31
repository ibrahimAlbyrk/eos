import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useSidePanelVisible } from "../../state/paneScope.js";
import { useArtifactCatalog } from "../../state/artifactCatalogStore.js";
import {
  artifactBridge, artifactHolder, attachArtifact, detachArtifact, onPeekEnd, openArtifactExternally,
  useArtifactStill, useArtifactViewState,
} from "../../state/artifactViewStore.js";
import { artifactSlugOf } from "../../lib/panelTabs.js";
import { artifactInfo, artifactRef, artifactTabHead } from "../../lib/artifacts.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { useOcclusion } from "../browser/useOcclusion.js";
import { AccountAvatar, CheckGlyph, ExternalGlyph, GridGlyph, LinkGlyph, RefreshGlyph, WindowGlyph } from "./ArtifactParts.jsx";
import { Sheen } from "../agents/messages/Sheen.jsx";

// The `artifact:<slug>` side-panel tab: a header line (account, version, link,
// actions) over the slot main lays the artifact's live view on (a native
// WebContentsView). This keeps the slot's rect and visibility in step and draws
// what sits under the view — the still, the sign-in card, a failed load. The artifact comes from
// the catalog; until it is there (a restored tab, someone else's artifact),
// from what the opener put in panelData.
export function ArtifactPanel({ tabId }) {
  const ui = useUi();
  const slug = artifactSlugOf(tabId);
  const seed = ui.panelData?.[tabId];
  const catalog = useArtifactCatalog();
  const info = artifactInfo(slug, seed ?? {}, catalog);
  if (!artifactBridge()) return <NoBridge info={info} />;
  return <ArtifactTab tabId={tabId} info={info} />;
}

// Inside the slot's 1px line, which stays visible around the view.
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
};
const sized = (r) => r.width > 0 && r.height > 0;
const sameRect = (a, b) => Boolean(a) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function ArtifactTab({ tabId, info }) {
  const ui = useUi();
  const bridge = artifactBridge();
  const slug = info.slug;
  const tabKey = `${ui.paneId}/${tabId}`;
  const refKey = `${slug}|${info.loginId}|${info.url}|${info.version}|${info.title}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const artRef = useMemo(() => artifactRef(info), [refKey]);
  const view = useArtifactViewState(slug);
  const still = useArtifactStill(artRef);
  const now = useClockTick(true, 30_000);
  const slotRef = useRef(null);

  const [docHidden, setDocHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // The panel stays mounted through its slide-out, but a native view ignores
  // DOM clipping — hide it the moment closing starts. A view in the sign-in or
  // error state gives way to the card drawn here.
  const tabShown = useSidePanelVisible();
  const blocked = view.state === "signin" || view.state === "error";
  const wanted = tabShown && ui.showSidePanel && !docHidden && !blocked;
  const occluded = useOcclusion(slotRef, wanted);
  const show = wanted && !occluded;
  const showRef = useRef(show);
  showRef.current = show;

  // attach on the first show, after another place took the view (a peek, the
  // same artifact in another pane), or when the artifact's ref changed; else
  // bounds + show. `sent` / `bounds` are what main last heard, so following the
  // layout only calls it when something moved.
  const viewKey = `${slug}|${info.loginId}|${info.url}|${info.version}`;
  const attached = useRef(null); // viewKey this tab last attached
  const sent = useRef(null);
  const bounds = useRef(null);
  const setVisible = useCallback((v) => {
    if (sent.current === v) return;
    sent.current = v;
    bridge.setVisible(tabKey, v);
  }, [bridge, tabKey]);
  const place = useCallback(() => {
    const el = slotRef.current;
    if (!el) return;
    const rect = rectOf(el);
    if (!sized(rect)) { if (attached.current) setVisible(false); return; }
    if (attached.current !== viewKey || artifactHolder(slug) !== tabKey) {
      attachArtifact(tabKey, artRef, rect);
      attached.current = viewKey;
      sent.current = true;
      bounds.current = rect;
      return;
    }
    if (!sameRect(bounds.current, rect)) {
      bridge.setBounds(tabKey, rect);
      bounds.current = rect;
    }
    setVisible(true);
  }, [bridge, tabKey, viewKey, slug, artRef, setVisible]);

  useEffect(() => {
    if (show) place();
    else if (attached.current) setVisible(false);
  }, [show, place, setVisible]);

  useEffect(() => onPeekEnd((s) => {
    if (s !== slug) return;
    attached.current = null;
    if (showRef.current) place();
  }), [slug, place]);

  // Follow the slot: its size, the window, and the layout moving it without
  // resizing it (the sidebar collapsing, the panel sliding in).
  useEffect(() => {
    if (!show) return;
    const el = slotRef.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (el) ro?.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("transitionend", place, true);
    window.addEventListener("animationend", place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("transitionend", place, true);
      window.removeEventListener("animationend", place, true);
    };
  }, [show, place]);

  useEffect(() => () => detachArtifact(tabKey, slug), [tabKey, slug]);

  return (
    <div className="panel-shell panel-shell--artifact">
      <ArtifactTabHead info={info} now={now} onReload={() => bridge.reload(slug)} onAll={() => ui.openPanel("artifacts")} />
      <div className="art-tab-slot" ref={slotRef}>
        {view.state === "signin" ? (
          <SignInCard info={info} onSignedIn={() => bridge.reload(slug)} />
        ) : view.state === "error" ? (
          <div className="empty-state art-tab-msg" role="alert">
            <span className="empty-state__icon"><WindowGlyph size={22} /></span>
            <span className="empty-state__title">This artifact didn't load</span>
            {view.error && <span className="empty-state__subtitle">{view.error}</span>}
            <button type="button" className="empty-state__action" onClick={() => bridge.reload(slug)}>Retry</button>
          </div>
        ) : still ? (
          <img className="art-tab-still" src={still} alt="" draggable={false} />
        ) : (
          <div className="art-tab-ph" data-tint={info.tint ?? undefined} aria-hidden="true">
            {info.favicon ? <span className="art-tab-ph__emoji">{info.favicon}</span> : <WindowGlyph size={24} />}
            <span className="art-tab-ph__title">{info.title}</span>
            {view.state !== "ready" && <span className="art-tab-ph__note ti-sheen-host">Loading…<Sheen>Loading…</Sheen></span>}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactTabHead({ info, now, onReload, onAll }) {
  const head = artifactTabHead(info, now);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard.writeText(info.url).then(() => setCopied(true), () => {});
  };
  const copyLabel = copied ? "Copied" : "Copy link";
  return (
    <div className="art-tab-head">
      {info.account && (
        <>
          <AccountAvatar account={info.account} size="head" />
          <span className="art-tab-head__acct">{info.account.label}</span>
          <span className="art-tab-head__sep" aria-hidden="true">·</span>
        </>
      )}
      {head.chip && (
        <>
          <span className="art-tab-head__chip">{head.chip}</span>
          <span className="art-tab-head__sep" aria-hidden="true">·</span>
        </>
      )}
      <span className="art-tab-head__link" title={info.url}>{head.link}</span>
      <button type="button" className="fv-icon-btn" aria-label="Reload" title="Reload" onClick={onReload}>
        <RefreshGlyph />
      </button>
      <button type="button" className="fv-icon-btn" aria-label={copyLabel} title={copyLabel} onClick={copy}>
        {copied ? <CheckGlyph /> : <LinkGlyph />}
      </button>
      <button type="button" className="fv-icon-btn" aria-label="All artifacts" title="All artifacts" onClick={onAll}>
        <GridGlyph />
      </button>
      <button type="button" className="fv-icon-btn" aria-label="Open on claude.ai" title="Open on claude.ai" onClick={() => openArtifactExternally(info.url)}>
        <ExternalGlyph />
      </button>
    </div>
  );
}

// The view's partition isn't signed in to claude.ai as the account that holds
// the artifact.
function SignInCard({ info, onSignedIn }) {
  const bridge = artifactBridge();
  const email = info.account?.email ?? null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const signIn = async () => {
    setBusy(true);
    setFailed(false);
    const r = await Promise.resolve(bridge.signIn(info.loginId, email ?? undefined)).catch(() => null);
    setBusy(false);
    if (r?.signedIn) onSignedIn();
    else setFailed(true);
  };
  return (
    <div className="empty-state art-tab-msg">
      <span className="empty-state__icon"><WindowGlyph size={22} /></span>
      <span className="empty-state__title">
        {email ? <>Sign in to claude.ai as {email} to open this account's artifacts</> : "Sign in to claude.ai to open this artifact"}
      </span>
      {failed && <span className="empty-state__subtitle">Not signed in{email ? ` as ${email}` : ""} yet.</span>}
      <button type="button" className="empty-state__action" onClick={signIn} disabled={busy}>
        {busy ? "Signing in…" : "Sign in to claude.ai"}
      </button>
    </div>
  );
}

// A plain browser or a view of another computer: no live views here.
function NoBridge({ info }) {
  return (
    <div className="panel-shell panel-shell--artifact">
      <div className="empty-state">
        <span className="empty-state__icon"><WindowGlyph size={22} /></span>
        <span className="empty-state__title">{info.title}</span>
        <span className="empty-state__subtitle">Artifacts open here in the Eos app on this Mac.</span>
        <a className="empty-state__action" href={info.url} target="_blank" rel="noopener noreferrer">Open on claude.ai</a>
      </div>
    </div>
  );
}
