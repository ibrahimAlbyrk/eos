import { useState } from "react";
import { fmtTimeAgo } from "../../../lib/format.js";

// Hover-revealed action row (copy + relative timestamp) under text messages.
export function MessageRow({ ts, copyText, align, children }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(copyText ?? "").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
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
        {ts != null && (
          <span className="msg-time" title={new Date(ts).toLocaleString()}>{fmtTimeAgo(ts)}</span>
        )}
      </div>
    </div>
  );
}
