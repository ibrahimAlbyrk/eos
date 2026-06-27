// The searchable spawn menu — opened by double-click / Tab on empty canvas (the
// quick-add) and by releasing a port-drag over empty canvas (the spawn menu,
// pre-filtered to compatible kinds). Keyboard-complete: type to filter, ↑/↓ to
// move, Enter to pick, Escape to close. The list of kinds + the pick action are
// supplied by FlowCanvas; this component is just the presentation + key handling.
import { useEffect, useMemo, useRef, useState } from "react";
import { filterKinds } from "./quickAdd.js";

export function QuickAddMenu({ clientX, clientY, kinds, onPick, onClose, title = "Add node" }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => filterKinds(kinds, query), [kinds, query]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const onKeyDown = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); onClose(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (ev.key === "Enter") { ev.preventDefault(); if (filtered[active]) onPick(filtered[active]); }
  };

  return (
    <>
      <div className="wf-qa-backdrop" onMouseDown={onClose} />
      <div className="wf-qa" style={{ left: clientX, top: clientY }} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="wf-qa__search"
          value={query}
          placeholder={`${title}…`}
          aria-label={title}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="wf-qa__list">
          {filtered.length === 0 && <div className="wf-qa__empty">no matching node</div>}
          {filtered.map((entry, i) => (
            <button
              type="button"
              key={entry.kind}
              className={"wf-qa__item" + (i === active ? " wf-qa__item--active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(entry)}
            >
              <span className="wf-qa__item-label">{entry.label}</span>
              <span className="wf-qa__item-kind">{entry.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
