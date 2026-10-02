import { useRef, useState } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";

// Blocks that paint a box wider than their text (code, tables, media, cards).
const BOXED = "pre, table, img, svg, video, canvas, iframe, hr, .report-detail";
const BESIDE_GAP = 10;
const EDGE_MARGIN = 8;

// Right edge (row-relative px) of what the message actually draws — its widest
// text line or boxed block — so a short reply gets its pill right after the last word.
function contentRight(row, pill) {
  const rowBox = row.getBoundingClientRect();
  const range = document.createRange();
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n === pill ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let right = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let box = null;
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.data.trim()) continue;
      range.selectNodeContents(n);
      box = range.getBoundingClientRect();
    } else if (n.matches(BOXED)) {
      box = n.getBoundingClientRect();
    }
    if (box?.width) right = Math.max(right, box.right - rowBox.left);
  }
  return Math.min(right, rowBox.width);
}

// Hover-revealed action pill (relative timestamp + optional rewind + copy +
// optional reply) beside text messages: left of a user bubble, right after the
// text otherwise (styles/transcript.css); under the message when there's no room.
// `onRewind` is an async () => {ok, error?}; the button
// renders only when it is provided. `rewindDisabled` keeps it visible but
// inert (dimmed) — e.g. while the agent is mid-turn and the backend would
// refuse the rewind anyway. `onReply` (when provided) sits at the pill's end.
export function MessageRow({ ts, copyText, align, onRewind, rewindDisabled, onReply, children }) {
  const [copied, setCopied] = useState(false);
  const [rewindState, setRewindState] = useState(null); // null | "busy" | "error"
  const [besideX, setBesideX] = useState(null); // pill's left edge when it fits right of the text
  const rowRef = useRef(null);
  const pillRef = useRef(null);

  // Measured on hover, not on render: text streams in and panes resize, and
  // the pill only matters while it's visible.
  const placePill = () => {
    const row = rowRef.current;
    const pill = pillRef.current;
    const scroller = row.closest(".messages-wrap");
    if (!scroller) return;
    const x = contentRight(row, pill) + BESIDE_GAP;
    const viewRight = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
    const room = viewRight - row.getBoundingClientRect().left - EDGE_MARGIN;
    setBesideX(x + pill.offsetWidth <= room ? x : null);
  };

  const copy = () => {
    navigator.clipboard.writeText(copyText ?? "").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const rewind = async () => {
    if (rewindDisabled || rewindState === "busy") return;
    setRewindState("busy");
    const r = await onRewind();
    if (r?.ok) {
      setRewindState(null);
    } else {
      setRewindState("error");
      setTimeout(() => setRewindState(null), 3000);
    }
  };

  return (
    <div className="msg-row" ref={rowRef} onMouseEnter={align === "right" ? undefined : placePill}>
      {children}
      <div
        ref={pillRef}
        className={"msg-actions" + (align === "right" ? " right" : besideX != null ? " beside" : "")}
        style={besideX != null ? { left: besideX } : undefined}
      >
        {ts != null && (
          <span className="msg-time" title={new Date(ts).toLocaleString()}>{fmtTimeAgo(ts)}</span>
        )}
        {onRewind && (
          <button
            className={"msg-action-btn" + (rewindDisabled || rewindState === "busy" ? " is-busy" : rewindState === "error" ? " is-err" : "")}
            onClick={rewind}
            disabled={rewindDisabled || rewindState === "busy"}
            title={rewindState === "error" ? "Rewind failed" : rewindDisabled ? "Agent is busy" : "Rewind to here"}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
        <button className="msg-action-btn" onClick={copy} title="Copy">
          {copied ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 8.5 3 3 7-7" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="8" y="8" width="13" height="13" rx="2.5" />
              <path d="M4 16V6a2 2 0 0 1 2-2h10" />
            </svg>
          )}
        </button>
        {onReply && (
          <button className="msg-action-btn" onClick={onReply} title="Reply">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
