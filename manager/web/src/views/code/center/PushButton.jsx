import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../api/client.js";

// Deterministic push with a celebratory choreography:
//   1. the unpushed-commit count (sourceRef, the sync chip) leaps in an arc and
//      drops INTO the button, leaving a green splash;
//   2. a green stroke traces the button's perimeter counter-clockwise from the
//      top-center back to the top-center;
//   3. on success the button fills green ("pushed" feel); on failure it flashes
//      red (the error detail lands in the chat git_push line).
// The push request fires immediately; the green fill is gated on the real result.

const STROKE = 2.4;
const RING_MS = 760;
const DROP_MS = 460;

const nextFrame = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// Rounded-rect outline as one path, drawn counter-clockwise starting/ending at
// top-center, so a stroke-dashoffset reveal sweeps CCW from the top.
function ringPath(w, h, radius) {
  const p = STROKE / 2;
  const rr = Math.max(0, Math.min(radius, Math.min(w, h) / 2 - p));
  const cx = w / 2;
  return [
    `M ${cx} ${p}`,
    `L ${p + rr} ${p}`,
    `A ${rr} ${rr} 0 0 0 ${p} ${p + rr}`,
    `L ${p} ${h - p - rr}`,
    `A ${rr} ${rr} 0 0 0 ${p + rr} ${h - p}`,
    `L ${w - p - rr} ${h - p}`,
    `A ${rr} ${rr} 0 0 0 ${w - p} ${h - p - rr}`,
    `L ${w - p} ${p + rr}`,
    `A ${rr} ${rr} 0 0 0 ${w - p - rr} ${p}`,
    `Z`,
  ].join(" ");
}

function PushIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5M5 8l3-3 3 3" />
      <line x1="4" y1="2.5" x2="12" y2="2.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 8.5 3.2 3.2L13 5" />
    </svg>
  );
}

export function PushButton({ workerId, label, ahead, sourceRef, onSettled }) {
  const btnRef = useRef(null);
  const ringRef = useRef(null);
  const dropRef = useRef(null);
  const busyRef = useRef(false);
  const [phase, setPhase] = useState("idle"); // idle | run | done | error
  const [ring, setRing] = useState(null);     // {w, h, d}
  const [drop, setDrop] = useState(null);      // {x, y, dx, dy, n}

  const reduceMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    const push = api.pushWorker(workerId).then((r) => r, () => ({ body: { ok: false } }));

    if (reduceMotion() || !btnRef.current) {
      const res = await push;
      await settle(res?.body?.ok);
      return;
    }

    const bb = btnRef.current.getBoundingClientRect();
    setRing({ w: bb.width, h: bb.height, d: ringPath(bb.width, bb.height, 6) });

    // Droplet: clone of the commit count, flying from the sync chip into the button.
    const src = sourceRef?.current?.getBoundingClientRect();
    if (src && ahead > 0) {
      const from = { x: src.left + src.width / 2, y: src.top + src.height / 2 };
      const to = { x: bb.left + bb.width / 2, y: bb.top + bb.height / 2 };
      sourceRef.current.style.transition = "opacity 140ms ease";
      sourceRef.current.style.opacity = "0";
      setDrop({ x: from.x, y: from.y, dx: to.x - from.x, dy: to.y - from.y, n: ahead });
      setPhase("run");
      await nextFrame();
      if (dropRef.current) {
        await dropRef.current.animate(
          [
            { transform: "translate(-50%,-50%) translate(0,0) scale(1)", opacity: 1, offset: 0 },
            { transform: `translate(-50%,-50%) translate(${(to.x - from.x) * 0.55}px, ${(to.y - from.y) * 0.5 - 20}px) scale(0.9)`, opacity: 1, offset: 0.55 },
            { transform: `translate(-50%,-50%) translate(${to.x - from.x}px, ${to.y - from.y}px) scale(0.2)`, opacity: 0.35, offset: 1 },
          ],
          { duration: DROP_MS, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "forwards" },
        ).finished;
      }
      setDrop(null);
    } else {
      setPhase("run");
      await nextFrame();
    }

    // Splash + counter-clockwise ring sweep.
    btnRef.current?.classList.add("splash");
    if (ringRef.current) {
      const total = ringRef.current.getTotalLength();
      ringRef.current.style.strokeDasharray = `${total}`;
      ringRef.current.style.strokeDashoffset = `${total}`;
      await ringRef.current.animate(
        [{ strokeDashoffset: total }, { strokeDashoffset: 0 }],
        { duration: RING_MS, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" },
      ).finished;
    }

    const res = await push;
    await settle(res?.body?.ok);
  }

  async function settle(ok) {
    setPhase(ok ? "done" : "error");
    await new Promise((r) => setTimeout(r, ok ? 760 : 1000));
    if (sourceRef?.current) { sourceRef.current.style.opacity = ""; sourceRef.current.style.transition = ""; }
    btnRef.current?.classList.remove("splash");
    setRing(null);
    setPhase("idle");
    busyRef.current = false;
    onSettled?.();
  }

  return (
    <span className={"push-fx" + (phase !== "idle" ? " is-" + phase : "")}>
      <button ref={btnRef} className="pr-create-btn pr-solo push-fx-btn" onClick={run} aria-busy={phase !== "idle"}>
        <span className="push-fx-face push-fx-label">
          <PushIcon /><span>{label}</span>
        </span>
        <span className="push-fx-face push-fx-check">
          <CheckIcon /><span>Pushed</span>
        </span>
      </button>
      {ring && (
        <svg className="push-ring" width={ring.w} height={ring.h} viewBox={`0 0 ${ring.w} ${ring.h}`} aria-hidden>
          <path ref={ringRef} d={ring.d} fill="none" stroke="var(--ok)" strokeWidth={STROKE} strokeLinecap="round" />
        </svg>
      )}
      {drop && createPortal(
        <span ref={dropRef} className="push-drop" style={{ left: drop.x, top: drop.y }}>
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 10V3M3 6l3-3 3 3" />
          </svg>
          <span>{drop.n}</span>
        </span>,
        document.body,
      )}
    </span>
  );
}
