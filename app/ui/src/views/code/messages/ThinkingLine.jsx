import { useLayoutEffect, useRef } from "react";
import { subscribe as subscribeThinking, getBlock } from "../../../state/thinkingStore.js";

// Inline reasoning line rendered as part of the assistant's turn — the raw
// reasoning text only, with no "thinking" label/prefix (the activity anchor
// under the latest message already signals motion).
//
// The content span is managed imperatively — React declares no children for it,
// so it never reconciles inside. While the block streams (live), each store
// flush appends ONLY the new tail as plain text nodes (reasoning is plain text,
// and text nodes need no escaping). Per-flush cost is O(tail) — never an
// innerHTML reset of the accumulated text. The durable block reuses this same
// instance by blockId; when the streamed DOM already equals the durable text
// the flip touches nothing, so the handoff has no reflash.
export function ThinkingLine({ text, live = false, interrupted = false, streamId, sessionId }) {
  const ref = useRef(null);
  const lenRef = useRef(0); // chars already appended to the DOM

  // Live streaming: subscribe to the store's coalesced flushes, append the tail.
  useLayoutEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (!el) return;
    const pull = () => {
      const full = getBlock(sessionId, streamId)?.text ?? "";
      if (full.length <= lenRef.current) return;
      const known = lenRef.current;
      lenRef.current = full.length;
      if (known === 0) {
        // Mount catch-up (first flush, or a remount mid-stream): one-time full set.
        el.textContent = full;
      } else {
        el.appendChild(document.createTextNode(full.slice(known)));
      }
    };
    pull();
    const unsub = subscribeThinking((wid) => { if (wid === sessionId) pull(); });
    return () => unsub();
  }, [live, sessionId, streamId]);

  // Durable content — set imperatively so streamed nodes and durable text share
  // one DOM owner. A flip whose text matches the streamed DOM leaves the nodes
  // untouched (no reflash).
  useLayoutEffect(() => {
    if (live) return;
    const el = ref.current;
    if (!el) return;
    const t = text ?? "";
    if (el.textContent !== t) {
      el.textContent = t;
      lenRef.current = t.length;
    }
  }, [live, text]);

  return (
    <div className="thinking-line">
      <span className="mono">
        <span ref={ref} />
        {interrupted && <span className="thinking-interrupted">interrupted</span>}
      </span>
    </div>
  );
}
