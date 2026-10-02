import { useEffect, useLayoutEffect, useRef } from "react";
import { ROLL_MS, nextRest, paintBall, restAngle, rocketEase, wrapAngle } from "../lib/ballRoll.js";

// Crouch on ignition, stretch at top speed, settle — timed to the roll.
const SQUASH = [
  { transform: "scale(1)" },
  { transform: "scale(1.05, 0.93)", offset: 0.24 },
  { transform: "scale(0.97, 1.04)", offset: 0.52 },
  { transform: "scale(1.01, 0.99)", offset: 0.8 },
  { transform: "scale(1)" },
];

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// The decals take the button's own text color (--accent-fg).
function inkOf(button) {
  const channels = getComputedStyle(button).color.match(/[\d.]+/g);
  return channels ? channels.slice(0, 3).map(Number) : [0, 0, 0];
}

function draw(button, canvas, theta, smear) {
  if (!button || !canvas) return;
  const px = Math.round(canvas.clientWidth * (window.devicePixelRatio || 1));
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  paintBall(canvas, theta, smear, inkOf(button));
}

// Drives the submit button's ball (lib/ballRoll.js): rests on the face for
// `stop` at mount, then rolls forward half a turn each time `stop` flips.
export function useBallRoll(stop) {
  const buttonRef = useRef(null);
  const canvasRef = useRef(null);
  const theta = useRef(restAngle(stop));
  const shownStop = useRef(stop);

  // Repaint on resize: covers a composer first laid out while hidden and DPR changes.
  useLayoutEffect(() => {
    const repaint = () => draw(buttonRef.current, canvasRef.current, theta.current, 0);
    repaint();
    if (typeof ResizeObserver !== "function" || !canvasRef.current) return;
    const ro = new ResizeObserver(repaint);
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (shownStop.current === stop) return;
    shownStop.current = stop;
    const button = buttonRef.current;
    const canvas = canvasRef.current;
    const from = theta.current;
    const to = nextRest(from, stop);
    if (reducedMotion()) {
      theta.current = wrapAngle(to);
      draw(button, canvas, theta.current, 0);
      return;
    }
    button?.animate?.(SQUASH, { duration: ROLL_MS, easing: "ease-in-out" });
    const start = performance.now();
    let prev = from;
    let raf = 0;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ROLL_MS);
      const angle = from + (to - from) * rocketEase(t);
      theta.current = t < 1 ? angle : wrapAngle(to);
      draw(button, canvas, theta.current, t < 1 ? Math.abs(angle - prev) : 0);
      prev = angle;
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [stop]);

  return { buttonRef, canvasRef };
}
