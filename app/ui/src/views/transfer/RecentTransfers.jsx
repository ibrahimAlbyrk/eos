import { useState } from "react";
import { fmtTimeAgoShort } from "../../lib/format.js";
import { ChevronRightIcon, IntoIcon, OutIcon } from "./icons.jsx";
import { namesOf } from "./text.js";

const NOTE = { failed: "failed", cancelled: "cancelled" };

// Finished transfers: one quiet row until it's opened.
export function RecentTransfers({ items, label, onClear }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <div className="tx-recent">
      <button type="button" className={"tx-recent__head" + (open ? " is-open" : "")} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tx-label">Recent</span>
        <span className="tx-recent__count">{items.length}</span>
        <span className="tx-recent__chev"><ChevronRightIcon /></span>
      </button>
      {open && (
        <div className="tx-recent__list">
          {items.map((t) => {
            const into = t.to === "local";
            return (
              <div key={t.id} className={"tx-recent__row" + (t.status === "done" ? "" : " is-dim")}>
                <span className="tx-recent__ic">{into ? <IntoIcon size={13} /> : <OutIcon size={13} />}</span>
                <span className="tx-recent__name">{namesOf(t)}</span>
                <span className="tx-recent__where">{NOTE[t.status] ?? label(into ? t.from : t.to)}</span>
                <span className="tx-recent__when mono">{fmtTimeAgoShort(t.finishedAt ?? t.createdAt)}</span>
              </div>
            );
          })}
          <button type="button" className="tx-recent__clear" onClick={onClear}>Clear</button>
        </div>
      )}
    </div>
  );
}
