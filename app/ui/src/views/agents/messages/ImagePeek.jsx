import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../api/client.js";
import { useHoverCard } from "../../../hooks/useHoverCard.js";

const OPEN_MS = 300;
const MAX_H = 240;
const MAX_W = 300;
const GAP = 6;
const EDGE = 8;

// Bare image over a tool row's file name — just the picture, no chrome. Fixed +
// portalled so the transcript's scroller can't clip it; it rises above the name
// and flips below when there is no room. Hidden until the image loads (a missing
// file shows nothing); any scroll closes it. Pointer-transparent: there is
// nothing to click in it, and it must not steal hover from the rows it covers.
function ImagePeek({ anchor, path, onClose }) {
  const [loaded, setLoaded] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const close = () => closeRef.current();
    window.addEventListener("scroll", close, true);
    return () => window.removeEventListener("scroll", close, true);
  }, []);

  const below = anchor.top - MAX_H - GAP < EDGE;
  const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - MAX_W - EDGE));
  const style = below ? { left, top: anchor.bottom + GAP } : { left, bottom: window.innerHeight - anchor.top + GAP };

  return createPortal(
    <div className={"img-peek" + (below ? " below" : "") + (loaded ? " is-loaded" : "")} style={style} aria-hidden="true">
      <img src={api.imageUrl(path)} alt="" onLoad={() => setLoaded(true)} onError={onClose} />
    </div>,
    document.body,
  );
}

// Hover handlers + portal layer for one image path; a null path disables it.
export function useImagePeek(path) {
  const card = useHoverCard({ openMs: OPEN_MS });
  if (!path) return { handlers: {}, layer: null, close: card.close };
  const handlers = {
    onMouseEnter: (e) => card.enterAnchor(e.currentTarget),
    onMouseLeave: card.leave,
  };
  const layer = card.anchor && <ImagePeek anchor={card.anchor} path={path} onClose={card.close} />;
  return { handlers, layer, close: card.close };
}
