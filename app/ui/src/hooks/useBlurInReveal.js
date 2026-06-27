import { useLayoutEffect } from "react";
import { applyBlurIn, clearBlurIn } from "../lib/blurInReveal.js";
import { revealedWords, setRevealedWords } from "../state/animationLedger.js";

// Reveals freshly arrived message text word-by-word. The count of words already
// on screen lives in the module-scope ledger keyed by (sessionId, blockId) — not
// a per-instance ref — so a block that grows across polls animates only its
// appended tail, and the count survives the live->durable handoff and remount.
// When disabled (parked/hidden pane, or already revealed) the effect early-returns:
// zero DOM mutation, zero timers. Layout effect: words must be wrapped before
// paint or the text flashes sharp for one frame. onSettle fires once the reveal
// completes so the caller can mark the block revealed in the ledger.
export function useBlurInReveal(ref, html, enabled, sessionId, blockId, onSettle) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const { total, settleMs } = applyBlurIn(el, revealedWords(sessionId, blockId));
    setRevealedWords(sessionId, blockId, total);
    if (!settleMs) { onSettle?.(); return; }
    const t = setTimeout(() => { clearBlurIn(el); onSettle?.(); }, settleMs + 100);
    return () => clearTimeout(t);
    // sessionId/blockId are stable per block instance and onSettle closes over
    // them, so re-running on their identity isn't needed (and would refire the
    // reveal); html/enabled are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, enabled]);
}
