import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./primitives.jsx";

const MAX_RESULTS = 50;

// Global event search — Cmd+Shift+F. Substring match across the global event
// cache (data.jsx state.events) so the user can find a tool call or message
// across all workers in the session.
export const SearchModal = memo(function SearchModal({ open, onClose, events, agents, onPick }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ("");
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const out = [];
    // Walk newest-first so the visible top of the list matches the user's
    // mental model of "what just happened".
    for (let i = events.length - 1; i >= 0 && out.length < MAX_RESULTS; i--) {
      const e = events[i];
      const haystack = `${e.body ?? ""} ${e.args ?? ""} ${e.tool ?? ""}`.toLowerCase();
      if (haystack.includes(needle)) out.push(e);
    }
    return out;
  }, [q, events]);

  if (!open) return null;

  const agentName = (id) => agents.find(a => a.id === id)?.name || id;

  return (
    <dialog
      ref={dialogRef}
      className="vb-search-overlay"
      aria-label="Search events"
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="vb-search-shell" onClick={(e) => e.stopPropagation()}>
        <div className="vb-search-head">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="vb-search-input"
            placeholder="Search across all events…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Event search query"
          />
          <span className="vb-search-hint">
            {q.trim() ? `${results.length} match${results.length === 1 ? "" : "es"}` : "type to search"}
          </span>
        </div>
        <ul className="vb-search-results" role="listbox" aria-label="Search results">
          {results.map((e) => (
            <li key={e.id} className="vb-search-result">
              <button onClick={() => { onPick(e); onClose(); }} className="vb-search-result__btn">
                <span className="vb-search-result__agent">{agentName(e.agent)}</span>
                <span className="vb-search-result__type">{e.type}</span>
                <span className="vb-search-result__body">{e.body || e.args || e.tool || ""}</span>
                <span className="vb-search-result__ts vb-mono">{e.ts}</span>
              </button>
            </li>
          ))}
          {q.trim() && results.length === 0 && (
            <li className="vb-search-empty">no matches</li>
          )}
        </ul>
      </div>
    </dialog>
  );
});
