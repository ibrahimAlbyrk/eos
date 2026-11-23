import { RUNGS } from "../../blueprint/FreedomLadder.jsx";

const rungLabel = (rung) => RUNGS.find((r) => r.value === rung)?.label ?? rung;

// A routine earned more freedom (03 §4.6): from which rung to which, and the
// streak that earned it. Allow raises it; Not now leaves it where it is.
export function FreedomOffer({ detail }) {
  const { from, rung, streak } = detail.payload ?? {};
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
      <p className="eos-needs-offer">
        <span>{rungLabel(from)}</span><span aria-hidden="true"> → </span><strong>{rungLabel(rung)}</strong>
      </p>
      {streak > 0 && <p className="eos-needs-card__class">{streak} in a row went out as written.</p>}
    </div>
  );
}
