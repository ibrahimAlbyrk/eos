import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";

const EDGE = 8; // closest the bar gets to the window edge

// Text message with a right-click action bar (relative timestamp + optional
// rewind + copy + optional reply) that opens at the pointer — nothing shows
// on hover, so the transcript's spacing never changes (styles/transcript.css).
// `onRewind` is an async () => {ok, error?, cancelled?}; the button
// renders only when it is provided. `rewindDisabled` keeps it visible but
// inert (dimmed) — e.g. while the agent is mid-turn and the backend would
// refuse the rewind anyway. `onReply` (when provided) sits at the bar's end.
export function MessageRow({ ts, copyText, align, onRewind, rewindDisabled, onReply, children }) {
  const [menuAt, setMenuAt] = useState(null); // pointer position in the row while the bar is open
  const [copied, setCopied] = useState(false);
  const [rewindState, setRewindState] = useState(null); // null | "busy" | "error"
  const rowRef = useRef(null);
  const closeMenu = useCallback(() => setMenuAt(null), []);

  const openMenu = (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const box = rowRef.current.getBoundingClientRect();
    setMenuAt({ x: e.clientX - box.left, y: e.clientY - box.top });
  };

  const copy = () => {
    navigator.clipboard.writeText(copyText ?? "").catch(() => {});
    setCopied(true);
    // Long enough to see the check, then the bar gets out of the way.
    setTimeout(() => { setCopied(false); setMenuAt(null); }, 700);
  };

  const reply = () => {
    setMenuAt(null);
    onReply();
  };

  const rewind = async () => {
    if (rewindDisabled || rewindState === "busy") return;
    setRewindState("busy");
    const r = await onRewind();
    if (r?.ok || r?.cancelled) {
      setRewindState(null);
      setMenuAt(null);
    } else {
      setRewindState("error");
      setTimeout(() => setRewindState(null), 3000);
    }
  };

  return (
    <div
      ref={rowRef}
      className={"msg-row" + (align === "right" ? " right" : "") + (menuAt ? " ctx-open" : "")}
      onContextMenu={openMenu}
    >
      {children}
      {menuAt && (
        <ActionBar at={menuAt} onClose={closeMenu}>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          )}
          <button className="msg-action-btn" onClick={copy} title="Copy">
            {copied ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 8.5 3 3 7-7" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="8" y="8" width="13" height="13" rx="2.5" />
                <path d="M4 16V6a2 2 0 0 1 2-2h10" />
              </svg>
            )}
          </button>
          {onReply && (
            <button className="msg-action-btn" onClick={reply} title="Reply">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
              </svg>
            </button>
          )}
        </ActionBar>
      )}
    </div>
  );
}

// Top-left corner at the pointer, like a native context menu, then kept inside
// the window: pulled left near the right edge, flipped above the pointer near
// the bottom. Closes on an outside press, Escape, or the window losing focus.
function ActionBar({ at, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const bar = ref.current;
    const row = bar.offsetParent.getBoundingClientRect();
    let left = at.x;
    let top = at.y;
    if (row.left + left + bar.offsetWidth > window.innerWidth - EDGE) left = window.innerWidth - EDGE - bar.offsetWidth - row.left;
    if (row.top + top + bar.offsetHeight > window.innerHeight - EDGE) top = at.y - bar.offsetHeight;
    setPos({ left, top });
  }, [at]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // A right-click on the bar itself must not reopen it at a new spot.
  const keepPlace = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="msg-actions glass-pop"
      role="toolbar"
      aria-label="Message actions"
      style={pos}
      onContextMenu={keepPlace}
    >
      {children}
    </div>
  );
}
