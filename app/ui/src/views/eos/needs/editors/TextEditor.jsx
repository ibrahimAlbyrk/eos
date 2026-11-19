import { Revert } from "./Revert.jsx";
import { partChanged, partOf, withText } from "./editDoc.js";

// A text result (a message, a note): one textarea per part, `body` for most.
export function TextEditor({ original, doc, onChange }) {
  return (
    <div className="eos-edit">
      {doc.parts.map((p) => (
        <div key={p.key} className="eos-edit__field">
          <div className="eos-edit__head">
            <label className="eos-edit__label" htmlFor={`edit-${p.key}`}>Text</label>
            <Revert shown={partChanged(doc, original, p.key)} what="text" onRevert={() => onChange(withText(doc, p.key, partOf(original, p.key).text))} />
          </div>
          <textarea id={`edit-${p.key}`} className="eos-edit__text" rows={8} value={p.text} onChange={(e) => onChange(withText(doc, p.key, e.target.value))} />
        </div>
      ))}
    </div>
  );
}
