import { useRef, useState } from "react";

const EXIT_MS = 180;
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Exit-fade for closed panes (deferred unmount). Diffs the live rect set against
// the previous render DURING render — not in an effect — so a pane that just left
// the tree is still rendered, as a ghost, on the SAME commit it disappears: React
// keeps the real instance mounted (no transcript remount, no enter-animation
// re-fire), the ghost sits over its last rect and fades out via WAAPI, then it's
// dropped. Survivors are untouched (they keep their leaf id; only their rect moves
// — Phase 1's CSS transition). Reduced-motion skips the fade (instant removal).
//
// Render-phase ref mutation is intentional here (the standard "animate on remove"
// technique): it caches derived state across renders and the app does not use
// StrictMode, so render runs once.
export function usePaneTransitions(rects) {
  const [, force] = useState(0);
  const prevRef = useRef([]); // rects from the previous render
  const leavingRef = useRef(new Map()); // id -> { id, agentId, rect } fading out
  const startedRef = useRef(new Set()); // ids whose exit animation has begun
  const animsRef = useRef(new Map()); // id -> Animation (to cancel on re-entry)

  const cur = rects;
  for (const p of prevRef.current) {
    if (!cur.some((c) => c.id === p.id)) leavingRef.current.set(p.id, p);
  }
  // A leaf that reappeared (e.g. close-then-reopen within the fade) cancels its
  // exit so the live pane isn't left mid-fade.
  for (const id of [...leavingRef.current.keys()]) {
    if (cur.some((c) => c.id === id)) {
      leavingRef.current.delete(id);
      startedRef.current.delete(id);
      animsRef.current.get(id)?.cancel();
      animsRef.current.delete(id);
    }
  }
  prevRef.current = cur;

  const drop = (id) => {
    leavingRef.current.delete(id);
    startedRef.current.delete(id);
    animsRef.current.delete(id);
    force((n) => n + 1);
  };

  // Ref-setter the renderer attaches to each ghost slot node; kicks off the WAAPI
  // exit the first time the real node is seen.
  const setNode = (id) => (node) => {
    if (!node || startedRef.current.has(id)) return;
    startedRef.current.add(id);
    if (reduceMotion() || typeof node.animate !== "function") { drop(id); return; }
    const anim = node.animate(
      [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.97)" }],
      { duration: EXIT_MS, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" },
    );
    animsRef.current.set(id, anim);
    anim.finished.then(() => drop(id)).catch(() => drop(id));
  };

  return { leaving: [...leavingRef.current.values()], setNode };
}
