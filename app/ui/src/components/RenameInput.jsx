import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

// Inline agent-rename input, shared by the sidebar rows and the header
// breadcrumb (and the file tree / pane presets, which pass no workerId).
// Commits on Enter/blur (once — doneRef guards the Enter→blur double fire),
// cancels on Escape or an unchanged value.
//
// workerId (optional): present only for AGENT renames. When the editor closes
// without committing, this is the single place that resumes the paused auto-name
// timer — a commit routes through onSave (PUT /name) which cancels it server-side.
export function RenameInput({ currentName, onSave, onCancel, workerId }) {
  const [value, setValue] = useState(currentName);
  const inputRef = useRef(null);
  const valueRef = useRef(value);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Closed without a committed rename → let the auto-name timer resume. Guarded
  // by doneRef (shared with commit) so a trailing blur can't fire it twice.
  const cancel = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (workerId) api.renameIntent(workerId, false).catch(() => {});
    onCancel();
  }, [workerId, onCancel]);

  const commit = useCallback(() => {
    if (doneRef.current) return;
    const trimmed = valueRef.current.trim();
    if (trimmed && trimmed !== currentName) { doneRef.current = true; onSave(trimmed); }
    else cancel();
  }, [currentName, onSave, cancel]);

  return (
    <input
      ref={inputRef}
      className="ag-rename-input"
      value={value}
      onChange={(e) => { setValue(e.target.value); valueRef.current = e.target.value; }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
