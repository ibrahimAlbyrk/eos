import { useState } from "react";
import { Revert } from "./Revert.jsx";
import { mailBody, partOf, partsOf, withMailBody, withText } from "./editDoc.js";

// A mail: its subject and its body. Recipients are fixed in the blueprint:
// shown locked, never edited or sent back as editable.
export function MailEditor({ original, doc, onChange }) {
  const to = partsOf(doc, "to:");
  const subject = partOf(doc, "subject");
  // The body as typed: paragraphs are split from it, so a blank line being
  // typed is not lost.
  const [body, setBody] = useState(() => mailBody(doc));
  const changeBody = (text) => {
    setBody(text);
    onChange(withMailBody(doc, text));
  };
  return (
    <div className="eos-edit">
      {to.length > 0 && (
        <p className="eos-result__to">
          To {to.map((r) => <span key={r.key} className="eos-chip eos-result__locked">{r.text}</span>)}
          <span className="eos-result__fixed">Fixed in the blueprint</span>
        </p>
      )}
      {subject && (
        <div className="eos-edit__field">
          <div className="eos-edit__head">
            <label className="eos-edit__label" htmlFor="edit-subject">Subject</label>
            <Revert shown={subject.text !== partOf(original, "subject")?.text} what="subject" onRevert={() => onChange(withText(doc, "subject", partOf(original, "subject").text))} />
          </div>
          <input id="edit-subject" type="text" className="eos-edit__line" value={subject.text} onChange={(e) => onChange(withText(doc, "subject", e.target.value))} />
        </div>
      )}
      <div className="eos-edit__field">
        <div className="eos-edit__head">
          <label className="eos-edit__label" htmlFor="edit-body">Body</label>
          <Revert shown={mailBody(doc) !== mailBody(original)} what="body" onRevert={() => changeBody(mailBody(original))} />
        </div>
        <textarea id="edit-body" className="eos-edit__text" rows={10} value={body} onChange={(e) => changeBody(e.target.value)} />
      </div>
    </div>
  );
}
