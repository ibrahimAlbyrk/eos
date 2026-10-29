import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useArtifactCatalog } from "../../state/artifactCatalogStore.js";
import {
  onArtifactAction, openArtifactExternally, peekArtifact, unpeekArtifact, useArtifactStill, useArtifactViewState,
} from "../../state/artifactViewStore.js";
import { artifactAccountLine, artifactInfo, artifactRef, artifactViewStatus, placeArtifactPeek } from "../../lib/artifacts.js";
import { useClockTick } from "../../hooks/useClockTick.js";
import { hostOS } from "../../lib/platform.js";
import { WindowGlyph } from "./ArtifactParts.jsx";

const ALT = hostOS() === "mac" ? "⌥" : "Alt";

// Glass hover card over an artifact link: main places the artifact's live view
// (a native miniature) in the inner slot, so the frame only draws the glass, the
// still under it and the footer. Fixed + portalled, in window coordinates, so
// any scroll or resize closes it. `link` = the anchor's readArtifactLink plus
// `panelLeft` for an anchor inside the side panel.
export function ArtifactPeek({ anchor, link, onEnter, onLeave, onClose, onOpen }) {
  const catalog = useArtifactCatalog();
  const now = useClockTick(true, 30_000);
  const info = artifactInfo(link.slug, link, catalog);
  const refKey = `${info.slug}|${info.loginId}|${info.url}|${info.version}|${info.title}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const artRef = useMemo(() => artifactRef(info), [refKey]);
  const view = useArtifactViewState(info.slug);
  const still = useArtifactStill(artRef);
  const pos = placeArtifactPeek(anchor, link.panelLeft, window.innerWidth, window.innerHeight);
  const status = artifactViewStatus(view.state);

  const hostRef = useRef(null);
  const slotRef = useRef(null);
  const inSlot = useRef(false);
  const latest = useRef({ onClose, onLeave, onOpen });
  latest.current = { onClose, onLeave, onOpen };

  useEffect(() => {
    const close = () => latest.current.onClose();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  useLayoutEffect(() => {
    const r = slotRef.current?.getBoundingClientRect();
    if (r) peekArtifact(artRef, { x: r.left, y: r.top, width: r.width, height: r.height });
  }, [artRef, pos.left, pos.top]);
  useEffect(() => () => unpeekArtifact(), []);
  // A click on the live miniature lands in the native view, which reports it.
  useEffect(() => onArtifactAction((a) => {
    if (a?.action === "open" && a.slug === info.slug) {
      latest.current.onOpen({ slug: info.slug, title: info.title, loginId: info.loginId, url: info.url });
    }
  }), [info.slug, info.title, info.loginId, info.url]);

  // The live page is a native view over the slot: the pointer moving onto it
  // leaves the DOM without entering anything else, so it must not count as
  // leaving. Wherever the pointer next reaches the DOM decides.
  const overSlot = (x, y) => {
    const r = slotRef.current?.getBoundingClientRect();
    return Boolean(r) && x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
  };
  useEffect(() => {
    const onOver = (e) => {
      if (!inSlot.current) return;
      inSlot.current = false;
      if (!hostRef.current?.contains(e.target)) latest.current.onLeave();
    };
    document.addEventListener("mouseover", onOver, true);
    return () => document.removeEventListener("mouseover", onOver, true);
  }, []);

  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) {
      onClose();
      openArtifactExternally(info.url);
      return;
    }
    onOpen({ slug: info.slug, title: info.title, loginId: info.loginId, url: info.url });
  };

  return createPortal(
    <a
      ref={hostRef}
      className={`art-peek glass-pop art-peek--${pos.side}`}
      href={info.url}
      aria-label={`Open ${info.title}`}
      style={{ left: pos.left, top: pos.top }}
      onClick={onClick}
      onMouseEnter={() => { inSlot.current = false; onEnter(); }}
      onMouseLeave={(e) => {
        if (overSlot(e.clientX, e.clientY)) inSlot.current = true;
        else onLeave();
      }}
    >
      <span className={"art-peek__slot" + (view.state === "ready" ? " is-live" : "")} ref={slotRef}>
        <span className="art-peek__under" data-tint={info.tint ?? undefined}>
          {still ? (
            <img className="art-peek__still" src={still} alt="" draggable={false} />
          ) : (
            <span className="art-peek__ph">
              {info.favicon ? <span className="art-peek__emoji">{info.favicon}</span> : <WindowGlyph size={22} />}
              <span className="art-peek__ph-title">{info.title}</span>
            </span>
          )}
        </span>
      </span>
      <span className="art-peek__foot">
        <span className={`art-dot art-dot--${status.tone}`} aria-hidden="true" />
        <span className="art-peek__status">{status.label}</span>
        <span className="art-peek__acct">{artifactAccountLine(info, now)}</span>
        <span className="art-peek__hint">Click to open · <kbd className="art-kbd">{ALT}</kbd> claude.ai</span>
      </span>
    </a>,
    document.body,
  );
}
