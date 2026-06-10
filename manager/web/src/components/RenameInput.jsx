import { useCallback, useEffect, useRef, useState } from "react";

// Inline agent-rename input, shared by the sidebar rows and the header
// breadcrumb. Commits on Enter/blur (once — doneRef guards the Enter→blur
// double fire), cancels on Escape or an unchanged value.
export function RenameInput({ currentName, onSave, onCancel }) {
  const [value, setValue] = useState(currentName);
  const inputRef = useRef(null);
  const valueRef = useRef(value);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = valueRef.current.trim();
    if (trimmed && trimmed !== currentName) onSave(trimmed);
    else onCancel();
  }, [currentName, onSave, onCancel]);

  return (
    <input
      ref={inputRef}
      className="ag-rename-input"
      value={value}
      onChange={(e) => { setValue(e.target.value); valueRef.current = e.target.value; }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
