import { useEffect } from "react";
import { saveInboxDraft } from "../../../../state/eos/inboxStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { carriedEdits, carryEdits, readEdit, writeEdit } from "../editDrafts.js";
import { MailEditor } from "../editors/MailEditor.jsx";
import { ReviewEditor } from "../editors/ReviewEditor.jsx";
import { TextEditor } from "../editors/TextEditor.jsx";
import { DocView, ResultView } from "../results/ResultView.jsx";

// How long typing pauses before the edits are kept in the core too.
const SAVE_AFTER_MS = 1500;

const EDITORS = { "github.review": ReviewEditor, mail: MailEditor };

// The draft as the run made it.
export function originalDoc(detail) {
  const doc = detail.payload?.doc;
  return Array.isArray(doc?.parts) ? doc : null;
}

// The draft as the user is editing it, or null while it is only read: the
// edit on screen, else one kept in this window, else one kept in the core.
export function currentEdit(detail, values) {
  if (values.edit !== undefined) return values.edit;
  return readEdit(detail.item.id, Date.now())?.doc ?? detail.working ?? null;
}

// The newer draft that replaced this one opens, the user's edits beside it.
export function followReplacement(detail) {
  const edit = readEdit(detail.item.id, Date.now());
  if (edit) carryEdits(detail.replacedBy, edit.doc);
  openLocation(`eos:/needs/${encodeURIComponent(detail.replacedBy)}`);
}

// A draft: read, or edited in place by its kind's editor. Every change is
// kept in this window at once and in the core once typing pauses.
export function DraftCard({ detail, values, setValue }) {
  const id = detail.item.id;
  const original = originalDoc(detail);
  const edit = original ? currentEdit(detail, values) : null;
  const carried = carriedEdits(id);
  useEffect(() => {
    if (!values.edit) return undefined;
    const timer = setTimeout(() => void saveInboxDraft(id, values.edit), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [id, values.edit]);

  const change = (next) => {
    setValue("edit", next);
    writeEdit(id, next, detail.item.rev, Date.now());
  };
  const Editor = EDITORS[original?.kind] ?? TextEditor;
  return (
    <div className={carried ? "eos-draft eos-draft--beside" : "eos-draft"}>
      {edit ? <Editor original={original} doc={edit} onChange={change} /> : <ResultView detail={detail} />}
      {carried && (
        <section className="eos-draft__carried" aria-label="Your edits">
          <h2 className="eos-label">Your edits</h2>
          <p className="eos-note">Made on the draft this one replaced. Copy what you still want.</p>
          <DocView doc={carried} />
        </section>
      )}
    </div>
  );
}
