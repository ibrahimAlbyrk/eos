import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// "New group" modal — reuses the delete-confirm overlay/surface design language.
// A single "Group name" field with Cancel / Save; Enter saves, Escape cancels.
// The caller creates the group and moves the agent into it on save. `title` and
// `initialName` let it double as a rename/save-layout prompt (default: new group).
export function NewGroupModal({ onSave, onCancel, title = "New group", initialName = "" }) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return createPortal(
    <div
      className="del-confirm-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="del-confirm glass-pop" role="dialog" aria-modal="true">
        <div className="del-confirm__body">
          <h2 className="stg-title">{title}</h2>
          <label className="ng-field-label" htmlFor="newGroupName">Group name</label>
          <input
            id="newGroupName"
            ref={inputRef}
            className="ng-field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              e.stopPropagation();
            }}
            placeholder="e.g. Frontend"
          />
          <div className="del-confirm__actions">
            <button className="del-confirm__cancel" onClick={onCancel}>Cancel</button>
            <button className="perm-btn perm-allow" disabled={!name.trim()} onClick={save}>Save</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
