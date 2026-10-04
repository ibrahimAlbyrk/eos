import { useEffect, useRef, useState } from "react";
import { deleteMemory, updateMemory } from "../../state/userMemoryStore.js";
import { sourceLabel } from "../../lib/memoryGroups.js";

const PinIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7" />
  </svg>
);

const TrashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);

// One kept memory: click the text to edit it (Enter saves, Esc cancels); the tier
// chip flips always-on ⇄ on-demand; delete goes to the store's trash.
export function MemoryItem({ memory }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.text);
  const ref = useRef(null);
  useEffect(() => { if (!editing) setDraft(memory.text); }, [memory.text, editing]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const save = () => {
    setEditing(false);
    const text = draft.trim();
    if (text && text !== memory.text) void updateMemory(memory.id, { text, baseRev: memory.rev });
  };
  const always = memory.tier === "always";

  return (
    <li className="mem-item">
      {editing ? (
        <textarea
          ref={ref}
          className="mem-item__edit"
          value={draft}
          rows={2}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
            if (e.key === "Escape") { setDraft(memory.text); setEditing(false); }
          }}
        />
      ) : (
        <button type="button" className="mem-item__text" title="Edit" onClick={() => setEditing(true)}>{memory.text}</button>
      )}
      <div className="mem-item__meta">
        <span className="mem-item__source">{sourceLabel(memory)}</span>
        <button
          type="button"
          className={`mem-tier${always ? " is-always" : ""}`}
          title={always ? "In every prompt — click to leave it for agents to look up" : "Agents look it up when relevant — click to put it in every prompt"}
          onClick={() => void updateMemory(memory.id, { tier: always ? "on-demand" : "always", baseRev: memory.rev })}
        >
          {always && <PinIcon />}{always ? "Always on" : "On demand"}
        </button>
        <button type="button" className="mem-item__del" aria-label="Delete memory" title="Delete" onClick={() => void deleteMemory(memory.id)}>
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}
