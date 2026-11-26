import { useInbox } from "../../../../state/eos/inboxStore.js";
import { FAILURES } from "../../capabilities/words.js";
import { UnconfirmedRecipients } from "../../routine/Unconfirmed.jsx";
import { AskRows, Fact } from "../../frame.jsx";
import { useRoutines } from "../../../../state/eos/routinesStore.js";
import { openLocation } from "../../nav/eosNav.js";
import { DocView } from "../results/ResultView.jsx";
import { editorOf, originalDoc } from "./DraftCard.jsx";

// What the item holds beyond its lead: for a delivery problem why it failed
// and the result that did not go out, in its editor once the user chose Edit
// and retry; for a routine's alert whose Resume was refused, who must be
// confirmed first. An item its lead says whole shows the routine it comes
// from: its name, what it does and when it runs, so a short ask still stands
// on its object.
export function PlainCard({ detail, values = {}, setValue }) {
  const refusal = useInbox().unconfirmed[detail.item.id];
  const why = FAILURES[detail.payload?.errorKind];
  const original = originalDoc(detail);
  const Editor = editorOf(original?.kind);
  if (!why && !refusal && !original) return <RoutineSource routineId={detail.item.routineId} />;
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

function RoutineSource({ routineId }) {
  const routine = useRoutines().list?.find((r) => r.id === routineId);
  if (!routine) return null;
  const rows = [
    ["From", (
      <button type="button" className="eos-link" onClick={() => openLocation(`eos:/routines/${encodeURIComponent(routine.id)}`)}>
        {routine.name}
      </button>
    )],
    routine.summary && ["Does", routine.summary],
    routine.triggerLine && ["Runs", routine.triggerLine],
  ].filter(Boolean);
  return <div className="eos-needs-card eos-needs-source"><AskRows rows={rows} /></div>;
}
