import { useEffect, useRef, useState } from "react";
import { useAgentPicker } from "./useAgentPicker.js";

// Hover-triggered agent picker shown inside an EMPTY split pane. A subtle resting
// hint invites the hover; on mouse-enter the glass card rises in, on mouse-leave
// it settles out. It NEVER opens while an agent drag is in progress (dragActive,
// derived from the pane's own drop-zone state) so it stays out of the existing
// drag-to-drop flow — native HTML5 drag also suppresses mouseenter, so the two
// guards together cover every case. Selection delegates to onPick.
export function AgentPickerOverlay({ live, excludeIds, focused, dragActive, onPick }) {
  const [hovered, setHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef(null);
  const { query, setQuery, items, activeIndex, setActiveIndex, moveBy } = useAgentPicker(
    live.workers,
    excludeIds,
  );

  const open = hovered && !dismissed && !dragActive;
  const noAgents = (live.workers?.length ?? 0) === 0;

  // Focus the filter when the picker opens on the FOCUSED pane, so keyboard nav
  // is immediate. A hover over a non-focused pane must not steal focus.
  useEffect(() => {
    if (open && focused) inputRef.current?.focus();
  }, [open, focused]);

  const pick = (id) => { if (id) onPick(id); };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveBy(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveBy(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); pick(items[activeIndex]?.id); return; }
    if (e.key === "Escape") { e.preventDefault(); setDismissed(true); inputRef.current?.blur(); return; }
    // Bare 1-9 are quick-picks ONLY while the filter is empty; once the user is
    // typing a filter, digits refine the search instead.
    if (query === "" && /^[1-9]$/.test(e.key)) {
      const it = items[Number(e.key) - 1];
      if (it) { e.preventDefault(); pick(it.id); }
    }
  };

  return (
    <div
      className="pane-picker-host"
      onMouseEnter={() => { setHovered(true); setDismissed(false); }}
      onMouseLeave={() => { setHovered(false); setDismissed(false); setQuery(""); }}
      onKeyDown={onKeyDown}
    >
      <div className={"pane-picker-hint" + (open ? " is-hidden" : "")} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
          <path d="M8 6v4M6 8h4" />
        </svg>
        <span>Hover to pick an agent</span>
      </div>

      <div className={"pane-picker" + (open ? " is-open" : "")} role="listbox" aria-label="Pick an agent">
        <div className="pane-picker-head">
          <span className="pane-picker-title">Pick an agent</span>
          <span className="pane-picker-count">{items.length}</span>
        </div>
        <input
          ref={inputRef}
          className="pane-picker-filter"
          placeholder="Filter agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          tabIndex={open ? 0 : -1}
        />
        <div className="pane-picker-list">
          {noAgents ? (
            <div className="pane-picker-empty">No agents yet</div>
          ) : items.length === 0 ? (
            <div className="pane-picker-empty">No matches</div>
          ) : (
            items.map((it, i) => (
              <AgentPickerItem
                key={it.id}
                item={it}
                index={i}
                showNum={query === "" && i < 9}
                active={i === activeIndex}
                onHover={() => setActiveIndex(i)}
                onPick={() => pick(it.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AgentPickerItem({ item, index, showNum, active, onHover, onPick }) {
  return (
    <button
      type="button"
      className={"pane-picker-item" + (active ? " is-active" : "") + (item.shown ? " is-shown" : "")}
      onMouseEnter={onHover}
      onClick={onPick}
      title={item.shown ? "Already open — focuses that pane" : undefined}
    >
      <span className={"ag-dot " + item.status.dot} />
      <span className={"pane-picker-name" + (item.isOrchestrator ? " main" : "")}>{item.label}</span>
      {item.shown
        ? <span className="pane-picker-shown">shown</span>
        : <span className="pane-picker-status">{item.status.label}</span>}
      {showNum && <span className="pp-num">{index + 1}</span>}
    </button>
  );
}
