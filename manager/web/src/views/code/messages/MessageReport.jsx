import { useState } from "react";

export function MessageReport({ text, label, direction }) {
  const [open, setOpen] = useState(false);
  const prefix = direction === "out" ? "Message from" : "Report from";

  return (
    <div className={"tool-item standalone" + (open ? " expanded" : "")}>
      <div className="tool-item-header" onClick={() => setOpen((o) => !o)}>
        <span className="ti-verb">{prefix}</span>
        <span className="ti-file">{label}</span>
        <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      {open && (
        <div className="report-detail">
          <div className="report-detail-text">{text}</div>
        </div>
      )}
    </div>
  );
}
