import { useState } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";

// Hover-revealed action pill (relative timestamp + optional rewind + copy +
// optional reply) under text messages: right-aligned under a user bubble,
// left-aligned under anything else. `onRewind` is an async () => {ok, error?}; the button
// renders only when it is provided. `rewindDisabled` keeps it visible but
// inert (dimmed) — e.g. while the agent is mid-turn and the backend would
// refuse the rewind anyway. `onReply` (when provided) sits at the pill's end.
export function MessageRow({ ts, copyText, align, onRewind, rewindDisabled, onReply, children }) {
  const [copied, setCopied] = useState(false);
  const [rewindState, setRewindState] = useState(null); // null | "busy" | "error"

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
    <div className="msg-row">
      {children}
      <div className={"msg-actions" + (align === "right" ? " right" : "")}>
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
