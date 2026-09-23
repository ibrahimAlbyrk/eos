import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtElapsedShort } from "../../../lib/format.js";

// TurnRail — the transcript's left-edge minimap: one tick per conversation
// turn. Hovering selects exactly one tick (white, longest) with its neighbours
// stepping down in length like a dock, and glides a preview card to it;
// clicking jumps to its prompt.
// Ticks whose turn is on screen stay lit, so the rail doubles as a position map.

const MAX_PITCH = 10;
const MIN_PITCH = 4;
// Vertical breathing room kept free above and below the rail.
const RAIL_MARGIN = 72;
const RAIL_PAD = 12;
// Length boost by distance (in ticks) from the selected one; beyond = rest.
const FALLOFF = [1, 0.4, 0.15];
// The selection only moves once the pointer is this close (fraction of pitch)
// to another tick's centre — between two ticks the current one holds.
const SNAP = 0.35;
const CARD_EDGE = 8;

export function TurnRail({ turns, scrollerRef, contentRef, busy, onJump }) {
  const railRef = useRef(null);
  const cardRef = useRef(null);
  const [frameH, setFrameH] = useState(0);
  const [hot, setHot] = useState(null);
  const [inView, setInView] = useState([-1, -1]);

  useLayoutEffect(() => {
    const frame = railRef.current?.parentElement;
    if (!frame) return;
    const ro = new ResizeObserver(() => setFrameH(frame.clientHeight));
    ro.observe(frame);
    return () => ro.disconnect();
  }, []);

  // Past capacity only the newest turns get a tick — older ones are a scroll away.
  const room = Math.max(0, frameH - RAIL_MARGIN * 2);
  const capacity = frameH ? Math.max(2, Math.floor(room / MIN_PITCH)) : Infinity;
  const offset = Math.max(0, turns.length - capacity);
  const shown = useMemo(() => (offset ? turns.slice(offset) : turns), [turns, offset]);
  const pitch = frameH ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, room / shown.length)) : MAX_PITCH;

  useEffect(() => {
    const wrap = scrollerRef.current;
    const content = contentRef.current;
    if (!wrap || !content) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = wrap.getBoundingClientRect();
      let next = content.getBoundingClientRect().bottom;
      let from = -1, to = -1;
      for (let i = shown.length - 1; i >= 0; i--) {
        const top = blockEl(content, shown[i].key)?.getBoundingClientRect().top;
        if (top == null) continue;
        if (top < box.bottom && next > box.top) { if (to < 0) to = i; from = i; }
        next = top;
      }
      setInView((p) => (p[0] === from && p[1] === to ? p : [from, to]));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    schedule();
    wrap.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(content);
    return () => {
      cancelAnimationFrame(raf);
      wrap.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [shown, scrollerRef, contentRef]);

  const onMove = (e) => {
    const y = e.clientY - railRef.current.getBoundingClientRect().top - RAIL_PAD;
    const near = Math.min(shown.length - 1, Math.max(0, Math.floor(y / pitch)));
    const off = Math.abs(y - (near * pitch + pitch / 2));
    setHot((h) => (h == null || near === h || off <= pitch * SNAP ? near : h));
  };
  const onLeave = () => setHot(null);

  // Park the card beside the hot tick, clamped inside the frame. Coming out of
  // hidden it snaps into place; between ticks it glides (CSS transition).
  const wasShown = useRef(false);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const rail = railRef.current;
    if (!card || !rail || hot == null) { wasShown.current = false; return; }
    const railTop = rail.offsetTop - rail.offsetHeight / 2; // rail is centered via translateY(-50%)
    const tickY = railTop + RAIL_PAD + hot * pitch + pitch / 2;
    const max = frameH - card.offsetHeight - CARD_EDGE;
    const top = Math.max(CARD_EDGE, Math.min(max, tickY - 16));
    if (!wasShown.current) {
      card.dataset.snap = "";
      requestAnimationFrame(() => delete card.dataset.snap);
    }
    card.style.transform = `translateY(${top}px)`;
    wasShown.current = true;
  }, [hot, pitch, frameH]);

  // The card keeps the last turn's content while it fades out.
  const lastHot = useRef(null);
  if (hot != null) lastHot.current = hot;
  const cardIdx = lastHot.current != null && lastHot.current < shown.length ? lastHot.current : null;
  const cardTurn = cardIdx != null ? shown[cardIdx] : null;
  const liveIdx = busy ? shown.length - 1 : -1;

  return (
    <>
      <nav
        className="turn-rail"
        aria-label="Conversation turns"
        ref={railRef}
        style={{ "--pitch": `${pitch}px`, padding: `${RAIL_PAD}px 0` }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        // The rail floats over the scroller's edge — pass the wheel through.
        onWheel={(e) => scrollerRef.current?.scrollBy(0, e.deltaY)}
      >
        {shown.map((t, i) => (
          <button
            key={t.key}
            type="button"
            tabIndex={-1}
            className={
              "turn-rail__tick" +
              (i >= inView[0] && i <= inView[1] ? " is-in-view" : "") +
              (i === liveIdx ? " is-live" : "") +
              (i === hot ? " is-hot" : "")
            }
            style={hot != null ? { "--k": FALLOFF[Math.abs(i - hot)] ?? 0 } : undefined}
            aria-label={`Turn ${offset + i + 1}: ${t.title}`}
            onClick={() => onJump(t.key)}
          />
        ))}
      </nav>
      <div className={"turn-card" + (hot != null ? " is-on" : "")} ref={cardRef} aria-hidden>
        {cardTurn && (
          <>
            <div className="turn-card__title">{cardTurn.title}</div>
            {cardTurn.preview && <div className="turn-card__body">{withBold(cardTurn.preview)}</div>}
            <div className="turn-card__meta mono">
              <span>{offset + cardIdx + 1} / {turns.length}</span>
              {cardTurn.tools > 0 && <span>{cardTurn.tools} tool{cardTurn.tools === 1 ? "" : "s"}</span>}
              {cardIdx === liveIdx
                ? <span className="turn-card__live">working</span>
                : cardTurn.endTs - cardTurn.startTs >= 1000 && <span>{fmtElapsedShort(cardTurn.endTs - cardTurn.startTs)}</span>}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function blockEl(content, key) {
  return content.querySelector(`[data-bkey="${CSS.escape(key)}"]`);
}

function withBold(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));
}
