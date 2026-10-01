import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useHoverCard } from "../../../hooks/useHoverCard.js";
import { artifactLabel } from "../../../lib/artifactLink.js";
import { useArtifactPreview, connectClaude } from "../../../state/artifactPreviewStore.js";

const PEEK_W = 320;
const PEEK_H = 240;
const GAP = 10;
const EDGE = 8;

const WindowIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" /><path d="M1.75 6h12.5" />
  </svg>
);
const ArrowIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 11.5l7-7M5.5 4.5h6v6" />
  </svg>
);

// Glass hover card over an artifact chip: the page's preview, title and link.
// Fixed + portalled so the transcript's scroller can't clip it; it rises above
// the chip and flips below when there is no room. Scrolling detaches it from the
// chip, so any scroll closes it.
function ArtifactPeek({ anchor, artifact, onEnter, onLeave, onClose }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = () => closeRef.current();
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, []);

  const below = anchor.top - PEEK_H - GAP < EDGE;
  const left = Math.max(EDGE, Math.min(anchor.left - 6, window.innerWidth - PEEK_W - EDGE));
  const style = below ? { left, top: anchor.bottom + GAP } : { left, bottom: window.innerHeight - anchor.top + GAP };

  const preview = useArtifactPreview(artifact.url);
  const connect = (e) => {
    e.preventDefault();
    e.stopPropagation();
    void connectClaude();
  };

  return createPortal(
    <a
      className={"art-peek glass-pop" + (below ? " below" : "")}
      href={artifact.url}
      style={style}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClose}
    >
      <span className={"art-peek-shot" + (preview.state === "ready" ? " is-shot" : "")}>
        {preview.state === "ready" ? (
          <img className="art-peek-img" src={preview.dataUrl} alt="" />
        ) : preview.state === "signin" ? (
          <button type="button" className="art-peek-connect" onClick={connect}>
            <WindowIcon />
            <span>Connect claude.ai to preview</span>
          </button>
        ) : (
          <span className={"art-peek-glyph" + (preview.state === "idle" ? " is-loading" : "")}><WindowIcon /></span>
        )}
      </span>
      <span className="art-peek-meta">
        <span className="art-peek-text">
          <span className="art-peek-title">{artifact.title ?? "Artifact"}</span>
          <span className="art-peek-url">{artifactLabel(artifact.url)}</span>
        </span>
        <span className="art-peek-hint">Click to open <ArrowIcon /></span>
      </span>
    </a>,
    document.body,
  );
}

// Delegated hover for every .art-chip under the element the handlers go on —
// prose chips are injected HTML, so they can't carry React handlers themselves.
export function useArtifactPeek() {
  const card = useHoverCard();
  const chipOf = (e) => e.target.closest?.(".art-chip");
  const crossing = (chip, e) => chip && !chip.contains(e.relatedTarget);

  const onMouseOver = (e) => {
    const chip = chipOf(e);
    if (crossing(chip, e)) card.enterAnchor(chip, { url: chip.getAttribute("href"), title: chip.dataset.title || null });
  };
  const onMouseOut = (e) => {
    if (crossing(chipOf(e), e)) card.leave();
  };

  const layer = card.anchor && (
    <ArtifactPeek anchor={card.anchor} artifact={card.payload} onEnter={card.enterCard} onLeave={card.leave} onClose={card.close} />
  );
  return { handlers: { onMouseOver, onMouseOut }, layer };
}
