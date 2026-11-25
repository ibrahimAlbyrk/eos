import { useEffect, useRef, useState } from "react";

// What a part is called on screen: its id in words ("live-ops" → "Live ops").
export function partName(part) {
  const words = String(part).replace(/[-_]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "This part";
}

// Where the popover sits: under the part pointed at, inside the page's
// width, or above it when there is no room below.
export function popoverPlace(rect, frameWidth, frameHeight, width = 320, height = 200) {
  const left = Math.max(8, Math.min(rect.x, frameWidth - width - 8));
  const below = rect.y + rect.height + 8;
  const top = below + height > frameHeight && rect.y - height - 8 > 0 ? rect.y - height - 8 : below;
  return { left, top };
}

// The part the user pointed at (SurfaceReshape.dc.html): its name, a line to
// say what should change there, Bigger and Smaller (for the designer), and
// Move up, Move down and Remove (done at once, no agent).
export function PointPopover({ pointed, place, busy, onSay, onArrange, onClose }) {
  const [text, setText] = useState("");
  const ref = useRef(null);
  const card = useRef(null);
  useEffect(() => {
    setText("");
    ref.current?.focus({ preventScroll: true });
    // A part low on screen opens the card under the whole-page line that
    // sticks at the foot: bring the card into view above it (scroll-margin).
    const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [pointed.part, pointed.index]);
  const name = partName(pointed.part);
  const say = (e) => {
    e.preventDefault();
    if (text.trim()) onSay(text.trim());
  };
  return (
    <div
      ref={card}
      className="eos-point"
      role="dialog"
      aria-label={`Change ${name}`}
      style={{ left: place.left, top: place.top }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <p className="eos-point__label">Change this part</p>
      <p className="eos-point__name">{name}</p>
      <form className="eos-point__say" onSubmit={say}>
        <input ref={ref} type="text" className="eos-point__input" aria-label="What should change here" placeholder="What should change here" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="eos-tell__send eos-point__send" aria-label="Change it" disabled={busy || !text.trim()}>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16"><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></svg>
        </button>
      </form>
      <div className="eos-point__picks" role="group" aria-label="Its size">
        <span className="eos-point__kind" aria-hidden="true">Size</span>
        <button type="button" className="eos-point__pick" disabled={busy} onClick={() => onSay(`Make ${name} bigger`)}>Bigger</button>
        <button type="button" className="eos-point__pick" disabled={busy} onClick={() => onSay(`Make ${name} smaller`)}>Smaller</button>
      </div>
      <div className="eos-point__picks" role="group" aria-label="Its place">
        <span className="eos-point__kind" aria-hidden="true">Place</span>
        <button type="button" className="eos-point__pick" disabled={busy} onClick={() => onArrange("move_up")}>Move up</button>
        <button type="button" className="eos-point__pick" disabled={busy} onClick={() => onArrange("move_down")}>Move down</button>
        <button type="button" className="eos-point__pick eos-point__pick--remove" disabled={busy} onClick={() => onArrange("remove")}>Remove</button>
      </div>
    </div>
  );
}
