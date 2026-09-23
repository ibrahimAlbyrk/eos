import { useState } from "react";
import { DisclosureRow } from "./DisclosureRow.jsx";

// A dynamic-loop automated re-trigger delivered into the worker's chat. Rendered
// as a distinct collapsible system row (NOT a user bubble) so the human watching
// can tell it apart from their own input.
export function MessageLoop({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool-item standalone">
      <DisclosureRow expanded={open} onToggle={() => setOpen((o) => !o)} className="tool-item-header">
        <span className="ti-verb">Dynamic loop — automated goal-check</span>
      </DisclosureRow>
      {open && (
        <div className="report-detail">
          <div className="report-detail-text">{text}</div>
        </div>
      )}
    </div>
  );
}
