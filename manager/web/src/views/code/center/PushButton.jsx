import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../api/client.js";
import { createRingProgress } from "./pushRingProgress.js";

// Deterministic push with a celebratory choreography:
//   1. the unpushed-commit count (sourceRef, the sync chip) leaps in an arc and
//      drops INTO the button, leaving a green splash;
//   2. a green stroke traces the button's perimeter counter-clockwise from the
//      top-center — born hidden, it trickles toward a cap while the push is in
//      flight and sprints to full only when the real result lands, so it never
//      sits complete before the push actually succeeded;
//   3. on success the button fills green ("pushed" feel); on failure it flashes
//      red around the frozen partial ring (the error detail lands in the chat
//      git_push line).
// The push request fires immediately; ring completion is gated on the real result.

const STROKE = 1.2;
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

export function PushButton({ workerId, label, ahead, sourceRef, onSourceFx, onSettled }) {
  const btnRef = useRef(null);
  const ringRef = useRef(null);
  const dropRef = useRef(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState("idle"); // idle | run | done | exit | error
  const [ring, setRing] = useState(null);     // {w, h, d}
  const [drop, setDrop] = useState(null);      // {x, y, n}

  useEffect(() => () => { mountedRef.current = false; }, []);

  const reduceMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    let outcome = null;
    const push = api.pushWorker(workerId)
      .then((r) => (outcome = { ok: Boolean(r?.body?.ok) }), () => (outcome = { ok: false }));

    if (reduceMotion() || !btnRef.current) {
      await push;
      await settle(outcome.ok);
      return;
    }

    const bb = btnRef.current.getBoundingClientRect();
    setRing({ w: bb.width, h: bb.height, d: ringPath(bb.width, bb.height, 6) });

    // Droplet: clone of the commit count, flying from the sync chip into the button.
    const src = sourceRef?.current?.getBoundingClientRect();
    if (src && ahead > 0) {
      const from = { x: src.left + src.width / 2, y: src.top + src.height / 2 };
      const to = { x: bb.left + bb.width / 2, y: bb.top + bb.height / 2 };
      // Hide the original count via a React-managed class (never mutate the
      // sibling's .style imperatively — React reuses that node and the stale
      // inline style would leak onto whatever renders there next).
      onSourceFx?.("sync-leaving");
      setDrop({ x: from.x, y: from.y, n: ahead });
      setPhase("run");
      await nextFrame();
      if (dropRef.current) {
        // Travels horizontally into the button (no vertical motion), shrinking
        // as it gets absorbed.
        const dx = to.x - from.x;
        await dropRef.current.animate(
          [
            { transform: "translate(-50%,-50%) translate(0,0) scale(1)", opacity: 1, offset: 0 },
            { transform: `translate(-50%,-50%) translate(${dx * 0.6}px,0) scale(0.92)`, opacity: 1, offset: 0.6 },
            { transform: `translate(-50%,-50%) translate(${dx}px,0) scale(0.2)`, opacity: 0.3, offset: 1 },
          ],
          { duration: DROP_MS, easing: "cubic-bezier(.4,0,.75,.45)", fill: "forwards" },
        ).finished;
      }
      setDrop(null);
    } else {
      setPhase("run");
      await nextFrame();
    }

    // Splash + result-coupled ring: trickle while the push is in flight and
    // sprint to full when the result lands; if the push already resolved
    // during the droplet, celebrate with one uninterrupted sweep instead.
    btnRef.current?.classList.add("splash");
    if (ringRef.current) {
      const ringFx = createRingProgress(ringRef.current);
      if (outcome) {
        if (outcome.ok) await ringFx.sweep();
      } else {
        ringFx.trickle();
        await push;
        if (outcome.ok) await ringFx.finish();
        else ringFx.fail();
      }
    } else {
      await push;
    }
    await settle(outcome.ok);
  }

  function reset() {
    onSourceFx?.("");
    btnRef.current?.classList.remove("splash");
    setRing(null);
    setPhase("idle");
    busyRef.current = false;
  }

  async function settle(ok) {
    if (!ok) {
      setPhase("error");
      await new Promise((r) => setTimeout(r, 1000));
      reset();
      onSettled?.();
      return;
    }
    setPhase("done");
    await new Promise((r) => setTimeout(r, 620));
    // Shrink + fade the whole cluster away (keeping the green look), then let
    // the data refresh unmount it while it's already faded — no abrupt pop.
    onSourceFx?.("sync-exit");
    setPhase("exit");
    await new Promise((r) => setTimeout(r, 300));
    onSettled?.();
    // Usually the refresh unmounts us here (nothing left to push). If concurrent
    // commits kept the button relevant, recover from the invisible exit state
    // instead of staying hidden until a manual refresh.
    setTimeout(() => { if (mountedRef.current) reset(); }, 450);
  }

  return (
    <span className={"push-fx" + (phase !== "idle" ? " is-" + phase : "")}>
      <button ref={btnRef} className="pr-create-btn pr-solo push-fx-btn" title={label} onClick={run} aria-busy={phase !== "idle"}>
        <span className="push-fx-face push-fx-label">
          <PushIcon /><span className="btn-label">{label}</span>
        </span>
        <span className="push-fx-face push-fx-check">
          <CheckIcon /><span className="btn-label">Pushed</span>
        </span>
      </button>
      {ring && (
        <svg className="push-ring" width={ring.w} height={ring.h} viewBox={`0 0 ${ring.w} ${ring.h}`} aria-hidden>
          <path ref={ringRef} d={ring.d} pathLength="1" fill="none" stroke="var(--ok)" strokeWidth={STROKE} strokeLinecap="round" style={{ strokeDasharray: "1", strokeDashoffset: "1" }} />
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
