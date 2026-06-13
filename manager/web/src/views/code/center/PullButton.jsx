import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { createRingProgress } from "./pushRingProgress.js";

// Deterministic fast-forward pull — the inverse of PushButton. Reuses the same
// push-fx choreography (ring trickle→finish/fail, splash, result-coupled
// faces) minus the droplet arc: a green stroke traces the button while the
// pull is in flight and sprints to full on success; on failure the ring
// freezes and the button flashes red (the detail lands in the chat git_pull
// line). A diverged branch never reaches here — the button only shows when the
// server reports a fast-forward is available.

const STROKE = 1.2;

const nextFrame = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// Rounded-rect outline as one path, CCW from top-center (matches PushButton).
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

function PullIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v8M5 8l3 3 3-3" />
      <line x1="4" y1="13.5" x2="12" y2="13.5" />
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

export function PullButton({ workerId, label = "Pull", onSettled }) {
  const btnRef = useRef(null);
  const ringRef = useRef(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const [phase, setPhase] = useState("idle"); // idle | run | done | exit | error
  const [ring, setRing] = useState(null);

  useEffect(() => () => { mountedRef.current = false; }, []);

  const reduceMotion = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function run() {
    if (busyRef.current) return;
    busyRef.current = true;
    let outcome = null;
    const pull = api.pullWorker(workerId)
      .then((r) => (outcome = { ok: Boolean(r?.body?.ok) }), () => (outcome = { ok: false }));

    if (reduceMotion() || !btnRef.current) {
      await pull;
      await settle(outcome.ok);
      return;
    }

    const bb = btnRef.current.getBoundingClientRect();
    setRing({ w: bb.width, h: bb.height, d: ringPath(bb.width, bb.height, 6) });
    setPhase("run");
    await nextFrame();

    btnRef.current?.classList.add("splash");
    if (ringRef.current) {
      const ringFx = createRingProgress(ringRef.current);
      if (outcome) {
        if (outcome.ok) await ringFx.sweep();
      } else {
        ringFx.trickle();
        await pull;
        if (outcome.ok) await ringFx.finish();
        else ringFx.fail();
      }
    } else {
      await pull;
    }
    await settle(outcome.ok);
  }

  function reset() {
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
    setPhase("exit");
    await new Promise((r) => setTimeout(r, 300));
    onSettled?.();
    setTimeout(() => { if (mountedRef.current) reset(); }, 450);
  }

  return (
    <span className={"push-fx" + (phase !== "idle" ? " is-" + phase : "")}>
      <button ref={btnRef} className="pr-create-btn pr-solo push-fx-btn" onClick={run} aria-busy={phase !== "idle"}>
        <span className="push-fx-face push-fx-label">
          <PullIcon /><span>{label}</span>
        </span>
        <span className="push-fx-face push-fx-check">
          <CheckIcon /><span>Pulled</span>
        </span>
      </button>
      {ring && (
        <svg className="push-ring" width={ring.w} height={ring.h} viewBox={`0 0 ${ring.w} ${ring.h}`} aria-hidden>
          <path ref={ringRef} d={ring.d} pathLength="1" fill="none" stroke="var(--ok)" strokeWidth={STROKE} strokeLinecap="round" style={{ strokeDasharray: "1", strokeDashoffset: "1" }} />
        </svg>
      )}
    </span>
  );
}
