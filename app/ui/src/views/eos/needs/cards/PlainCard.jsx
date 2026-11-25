import { useInbox } from "../../../../state/eos/inboxStore.js";
import { FAILURES } from "../../capabilities/words.js";
import { UnconfirmedRecipients } from "../../routine/Unconfirmed.jsx";
import { Fact } from "../../frame.jsx";
import { DocView } from "../results/ResultView.jsx";
import { editorOf, originalDoc } from "./DraftCard.jsx";

// What the item holds beyond its lead: for a delivery problem why it failed
// and the result that did not go out, in its editor once the user chose Edit
// and retry; for a routine's alert whose Resume was refused, who must be
// confirmed first. Nothing for an item its lead says whole.
export function PlainCard({ detail, values = {}, setValue }) {
  const refusal = useInbox().unconfirmed[detail.item.id];
  const why = FAILURES[detail.payload?.errorKind];
  const original = originalDoc(detail);
  const Editor = editorOf(original?.kind);
  if (!why && !refusal && !original) return null;
  return (
    <div className="eos-needs-card">
      {why && <Fact className="eos-needs-card__class">{why}</Fact>}
      {refusal && <UnconfirmedRecipients refusal={refusal} routineId={detail.item.routineId} />}
      {original && (
        <article className="eos-needs-sheet" aria-label={values.edit ? "What did not go out, being edited" : "What did not go out"}>
          {values.edit
            ? <Editor original={original} doc={values.edit} onChange={(next) => setValue("edit", next)} />
            : <DocView doc={original} />}
        </article>
      )}
    </div>
  );
}
