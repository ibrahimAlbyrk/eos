import { useEffect, useRef, useState } from "react";
import { TrashIcon, PencilIcon } from "../../../lib/gitIconKit.jsx";
import { BranchContextMenu } from "../popovers/BranchContextMenu.jsx";

// Messages the user sent while the agent was busy, waiting in the daemon queue
// (next to dispatch = top). Sits in the tray slot behind the composer card.
// Steer sends one now, mid-turn; Edit pulls it back into the input.
export function QueueTray({ items, onSteer, onEdit, onDismiss }) {
  const listRef = useRef(null);
  const [menu, setMenu] = useState(null); // { item, x, y }

  // Keep the newest (bottom) row in view as messages are queued.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const openMenu = (item, e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ item, x: r.right - 220, y: r.bottom + 4 });
  };

  return (
    <div className="queue-tray">
      <div className="queue-tray-list" ref={listRef}>
        {items.map((q) => (
          <div key={q.id} className={"queue-row" + (menu?.item.id === q.id ? " on" : "")}>
            <QueueGlyph />
            <span className="queue-row-text" title={q.text}>{q.text}</span>
            <button className="queue-steer" title="Send now, into the running turn" onClick={() => onSteer(q)}>
              <SteerGlyph />
              <span>Steer</span>
            </button>
            <button className="queue-ic" title="Remove from queue" onClick={() => onDismiss(q)}>
              <TrashIcon size={13} />
            </button>
            <button className="queue-ic" title="More" onClick={(e) => openMenu(q, e)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {menu && (
        <BranchContextMenu
          x={menu.x}
          y={menu.y}
          popover="queue-menu"
          onClose={() => setMenu(null)}
          items={[{ label: "Edit message", icon: <PencilIcon size={13} />, onClick: () => onEdit(menu.item) }]}
        />
      )}
    </div>
  );
}

function QueueGlyph() {
  return (
    <svg className="queue-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h9M2.5 7h6M2.5 10.5h3.5" />
      <path d="M9 10.5h4.5M11.5 8.5l2 2-2 2" />
    </svg>
  );
}

function SteerGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v4a3 3 0 0 0 3 3h7.5M10.5 7l3 3-3 3" />
    </svg>
  );
}
