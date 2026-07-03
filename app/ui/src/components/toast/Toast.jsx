import { useEffect, useRef, useState } from "react";
import { beginExit, dismiss } from "../../state/toastStore.js";

// Severity presentation is DATA, not branching: adding a severity is one row
// here + one CSS modifier + one wrapper on notify (OCP). Each entry maps to a
// --tone token in styles.css via the `toast--<severity>` class.
const SEVERITY = {
  info: { label: "Info", role: "status", glyph: "i" },
  warning: { label: "Warning", role: "status", glyph: "!" },
  error: { label: "Error", role: "alert", glyph: "!" },
};

const DRAG_THRESHOLD = 80; // px to the right before a release dismisses
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// One toast card. Owns its own clock (auto-dismiss, pause on hover/drag), its
// right-only drag gesture, and its exit hand-off — SRP: the store owns the list,
// this owns a single toast's lifecycle.
export function Toast({ id, severity, message, title, duration, dismissible, leaving }) {
  const meta = SEVERITY[severity] ?? SEVERITY.info;

  // Timer kept in refs so hover/drag can pause it while preserving the leftover
  // time (rather than restarting the full duration on resume).
  const remainingRef = useRef(duration);
  const startedRef = useRef(0);
  const timerRef = useRef(null);

  const startTimer = () => {
    clearTimeout(timerRef.current);
    startedRef.current = performance.now();
    timerRef.current = setTimeout(() => beginExit(id), remainingRef.current);
  };
  const pauseTimer = () => {
    clearTimeout(timerRef.current);
    remainingRef.current -= performance.now() - startedRef.current;
  };

  useEffect(() => {
    startTimer();
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once leaving, stop the clock and guarantee removal: the .leaving CSS
  // transitions the card off-screen and onTransitionEnd calls dismiss(), but if
  // the transition is suppressed (reduced motion, no transition support) that
  // event never fires — so a timeout races it as a fallback (mirrors
  // usePaneTransitions' reduced-motion drop).
  useEffect(() => {
    if (!leaving) return;
    clearTimeout(timerRef.current);
    const ms = reduceMotion() ? 140 : 400;
    const fallback = setTimeout(() => dismiss(id), ms);
    return () => clearTimeout(fallback);
  }, [leaving, id]);

  // Right-only pointer drag. Uses setPointerCapture like the effort slider so the
  // gesture keeps tracking outside the card; leftward motion is clamped to 0.
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);

  const onPointerDown = (e) => {
    if (leaving) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    setDragging(true);
    startXRef.current = e.clientX;
    pauseTimer();
  };
  const onPointerMove = (e) => {
    if (!draggingRef.current) return;
    setDx(Math.max(0, e.clientX - startXRef.current));
  };
  const onPointerUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (dx > DRAG_THRESHOLD) {
      beginExit(id); // fling → slide the rest of the way out
    } else {
      setDx(0); // snap back (CSS transition) + resume where the timer left off
      startTimer();
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape" && dismissible) {
      e.stopPropagation();
      beginExit(id);
    }
  };

  const style = dx
    ? { transform: `translateX(${dx}px)`, opacity: Math.max(0, 1 - dx / 160) }
    : undefined;

  return (
    <div
      className={
        "toast glass-pop toast--" + severity +
        (dragging ? " dragging" : "") +
        (leaving ? " leaving" : "")
      }
      role={meta.role}
      aria-atomic="true"
      style={style}
      onMouseEnter={pauseTimer}
      onMouseLeave={() => { if (!draggingRef.current && !leaving) startTimer(); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onTransitionEnd={(e) => {
        if (leaving && (e.propertyName === "transform" || e.propertyName === "opacity")) dismiss(id);
      }}
      tabIndex={0}
    >
      <span className="toast__glyph" aria-hidden="true">{meta.glyph}</span>
      <div className="toast__body">
        {title && <div className="toast__title">{title}</div>}
        <div className="toast__msg">{message}</div>
      </div>
      {dismissible && (
        <button
          type="button"
          className="toast__close"
          aria-label="Dismiss"
          onClick={() => beginExit(id)}
          // A click that ends a drag shouldn't also toggle the button.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
    </div>
  );
}
