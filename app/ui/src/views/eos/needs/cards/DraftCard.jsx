import { useEffect } from "react";
import { saveInboxDraft } from "../../../../state/eos/inboxStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { carriedEdits, carryEdits, readEdit, writeEdit } from "../editDrafts.js";
import { docChanged } from "../editors/editDoc.js";
import { MailEditor } from "../editors/MailEditor.jsx";
import { ReviewEditor } from "../editors/ReviewEditor.jsx";
import { SlackEditor } from "../editors/SlackEditor.jsx";
import { TextEditor } from "../editors/TextEditor.jsx";
import { PageItem } from "../ItemView.jsx";
import { DocView, ResultView } from "../results/ResultView.jsx";
import { SendState } from "../SendState.jsx";
import { staleLine } from "../words.js";

// How long typing pauses before the edits are kept in the core too.
const SAVE_AFTER_MS = 1500;

const WAITING = new Set(["open", "later"]);

const EDITORS = { "github.review": ReviewEditor, mail: MailEditor, "slack.message": SlackEditor, "slack.reply": SlackEditor };

// The editor for a result of `kind`.
export const editorOf = (kind) => EDITORS[kind] ?? TextEditor;

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

// Whether the edit on screen is to be kept in the core: only when it
// differs from what the core holds, so opening the editor writes nothing.
export function needsSave(detail, edit) {
  const kept = detail.working ?? originalDoc(detail);
  return Boolean(edit && kept) && docChanged(edit, kept);
}

// Its subject moved on since it was made (new commits): sending needs a
// second yes.
export const isStale = (detail) => detail.item.staleAt != null;

// The newer draft that replaced this one opens, the user's edits beside it.
export function followReplacement(detail) {
  const edit = readEdit(detail.item.id, Date.now());
  if (edit) carryEdits(detail.replacedBy, edit.doc);
  openLocation(`eos:/needs/${encodeURIComponent(detail.replacedBy)}`);
}

// The page issue a page draft sends: its page and its id, from the part
// that names it.
export function pageOf(doc) {
  if (doc?.kind !== "page.issue") return null;
  const part = doc.parts.find((p) => p.key === "@issue");
  return part?.meta?.surface ? { surfaceId: part.meta.surface, issueId: part.text } : null;
}

// Who a page draft goes to: fixed by the blueprint.
function PageTo({ doc }) {
  const to = doc.parts.filter((p) => p.key.startsWith("to:"));
  if (to.length === 0) return null;
  return (
    <p className="eos-result__to">
      To {to.map((r) => <span key={r.key} className="eos-chip eos-result__locked">{r.text}</span>)}
      <span className="eos-result__fixed">Fixed in the blueprint</span>
    </p>
  );
}

// A draft: read, or edited in place by its kind's editor. Every change is
// kept in this window at once and in the core once typing pauses.
export function DraftCard({ detail, values, setValue, routineName }) {
  const id = detail.item.id;
  const original = originalDoc(detail);
  const edit = original ? currentEdit(detail, values) : null;
  const carried = carriedEdits(id);
  const unsaved = needsSave(detail, values.edit);
  useEffect(() => {
    if (!unsaved) return undefined;
    const timer = setTimeout(() => void saveInboxDraft(id, values.edit), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [id, values.edit, unsaved]);

  const change = (next) => {
    setValue("edit", next);
    writeEdit(id, next, detail.item.rev, Date.now());
  };
  const Editor = editorOf(original?.kind);
  const page = pageOf(original);
  if (page) {
    // A page is edited on the page itself: the mail draws the issue as it is when it goes.
    return (
      <div className="eos-draft">
        <SendState detail={detail} />
        <PageTo doc={original} />
        <PageItem surfaceId={page.surfaceId} issueId={page.issueId} routineName={routineName} />
      </div>
    );
  }
  return (
    <div className={carried ? "eos-draft eos-draft--beside" : "eos-draft"}>
      <SendState detail={detail} />
      {isStale(detail) && WAITING.has(detail.item.state) && <p className="eos-needs-stale" role="status">{staleLine(detail.item.staleReason)}</p>}
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
