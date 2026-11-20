import { FAILURES } from "../../capabilities/words.js";
import { editorOf, originalDoc } from "./DraftCard.jsx";

// The item in words: its summary, and for a delivery problem why it failed,
// with the result it would send in its editor once the user chose Edit and
// retry.
export function PlainCard({ detail, values = {}, setValue }) {
  const why = FAILURES[detail.payload?.errorKind];
  const original = originalDoc(detail);
  const Editor = editorOf(original?.kind);
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
      {why && <p className="eos-needs-card__class">{why}</p>}
      {original && values.edit && <Editor original={original} doc={values.edit} onChange={(next) => setValue("edit", next)} />}
    </div>
  );
}

// A suggestion about the user: Eos's guess, asked back.
export function AboutYouCard({ detail }) {
  return (
    <div className="eos-needs-card">
      <p className="eos-needs-card__lead">{detail.item.title}</p>
      <p className="eos-needs-card__class">Is this right about you?</p>
    </div>
  );
}
