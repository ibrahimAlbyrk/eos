import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { notify } from "../../../lib/notify.js";
import { useInWindow } from "../frame.jsx";
import { word } from "../routines/tableWords.js";

// How long a notice stays before it goes by itself, by tone: what went wrong
// stays longest. Hovering or focusing the stack holds them.
const STAYS_MS = { info: 5000, warning: 8000, error: 12000 };
const MOST = 3;
const TONE = { info: "", warning: "warn", error: "err" };

// What an Eos screen was told while it shows (notify.*): one solid line in the
// foot's right corner of the main column, on its gutter's edge, its tone as
// the 9 px mark, the title strong and the words dim, Dismiss at the right.
// Only the newest shows; the others wait behind it as "2 more", which opens
// them as a stack, newest last. Nothing is drawn
// while there is nothing to say. The stack lives over the whole window, so a
// notice raised under Settings or one of Eos's dialogs is not under their
// shade; an anchor in the main column keeps it at that column's foot.
export function Notices() {
  const [shown, setShown] = useState([]);
  const [held, setHeld] = useState(false);
  const [at, setAt] = useState(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef(null);
  const inWindow = useInWindow();
  const some = shown.length > 0;
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!some || !el) return undefined;
    const place = () => {
      const r = el.getBoundingClientRect();
      const gutter = Math.min(56, Math.max(24, r.width * 0.04));
      setAt({ right: window.innerWidth - r.right + gutter, bottom: window.innerHeight - r.bottom + 24, width: `min(420px, ${Math.max(0, r.width - 2 * gutter)}px)` });
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    window.addEventListener("resize", place);
    return () => { watch.disconnect(); window.removeEventListener("resize", place); };
  }, [some]);
  useEffect(() => {
    let next = 0;
    return notify.listen((notice) => {
      next += 1;
      const id = next;
      setShown((all) => [...all, { ...notice, id }].slice(-MOST));
    });
  }, []);
  useEffect(() => {
    if (!shown.length) setOpen(false);
    if (held || !shown.length) return undefined;
    const first = shown[0];
    const timer = setTimeout(() => setShown((all) => all.filter((n) => n.id !== first.id)), STAYS_MS[first.tone] ?? STAYS_MS.info);
    return () => clearTimeout(timer);
  }, [shown, held]);
  const spot = <span ref={anchor} className="eos-notices-anchor" aria-hidden="true" />;
  if (!some) return spot;
  const drop = (id) => setShown((all) => all.filter((n) => n.id !== id));
  const more = shown.length - 1;
  const drawn = open || more === 0 ? shown : shown.slice(-1);
  const stack = (
    <div className="eos-notices" style={at ?? undefined} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      {drawn.map((n) => (
        <div key={n.id} className={TONE[n.tone] ? `eos-notice eos-notice--${TONE[n.tone]}` : "eos-notice"} role={n.tone === "error" ? "alert" : "status"}>
          <p className="eos-notice__words">
            {n.title && <strong>{n.title}</strong>}
            <span>{n.message}</span>
            {!open && more > 0 && <button type="button" className="eos-notice__more" onClick={() => setOpen(true)}>{word(more)} more</button>}
          </p>
          <button type="button" className="eos-notice__close" aria-label="Dismiss" onClick={() => drop(n.id)}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
  return <>{spot}{inWindow ? createPortal(stack, document.body) : stack}</>;
}
