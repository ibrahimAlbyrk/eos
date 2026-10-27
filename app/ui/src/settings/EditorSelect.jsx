import { preferredEditor, useEditors } from "../state/editorsStore.js";
import { SelectControl } from "./controls.jsx";

// Settings › Code › Files & links › Editor: the editors installed on this Mac.
// An unset (or uninstalled) choice shows the one paths open in — the first installed.
export function EditorSelect({ value, onChange }) {
  const editors = useEditors();
  if (editors.length === 0) return <span className="stg-note">No supported editor found</span>;
  const current = preferredEditor(editors, value);
  return (
    <SelectControl
      value={current.id}
      onChange={onChange}
      options={editors.map((e) => ({ value: e.id, label: e.name }))}
    />
  );
}
