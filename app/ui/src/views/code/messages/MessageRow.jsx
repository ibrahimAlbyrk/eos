import { useState } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";

// Hover-revealed action row (copy + optional rewind + relative timestamp)
// under text messages. `onRewind` is an async () => {ok, error?}; the button
// renders only when it is provided. `rewindDisabled` keeps it visible but
// inert (dimmed) — e.g. while the agent is mid-turn and the backend would
// refuse the rewind anyway.
export function MessageRow({ ts, copyText, align, onRewind, rewindDisabled, children }) {
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
        <button className="msg-action-btn" onClick={copy} title="Copy">
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 8.5 3 3 7-7" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="5" y="5" width="9" height="9" rx="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
            </svg>
          )}
        </button>
        {onRewind && (
          <button
            className={"msg-action-btn" + (rewindDisabled || rewindState === "busy" ? " is-busy" : rewindState === "error" ? " is-err" : "")}
            onClick={rewind}
            disabled={rewindDisabled || rewindState === "busy"}
            title={rewindState === "error" ? "Rewind failed" : rewindDisabled ? "Agent is busy" : "Rewind to here"}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 3.5 3 7l3.5 3.5" />
              <path d="M3 7h6a4 4 0 0 1 4 4v1.5" />
            </svg>
          </button>
        )}
        {ts != null && (
          <span className="msg-time" title={new Date(ts).toLocaleString()}>{fmtTimeAgo(ts)}</span>
        )}
      </div>
    </div>
  );
}
