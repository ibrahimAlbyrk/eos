import { RUNGS } from "../../blueprint/FreedomLadder.jsx";
import { OFFER_AFTER, Streak } from "../StreakLine.jsx";

const rungLabel = (rung) => RUNGS.find((r) => r.value === rung)?.label ?? rung;

// What each rung lets the routine do, under its name on the ladder.
const RUNG_WORDS = { ask: "asks before it starts", draft: "you send what it drafts", send_then_tell: "it sends, you can undo", on_its_own: "it sends, says nothing" };

// A routine earned more freedom (03 §4.6), drawn as the ladder's rungs on
// one line: the way it has come solid, the rung it stands on, the one it
// is offered lit, the rest ahead dashed; then the streak that earned it.
// Allow raises it; Not now leaves it where it is.
export function FreedomOffer({ detail }) {
  const { from, rung, streak } = detail.payload ?? {};
  const at = RUNGS.findIndex((r) => r.value === from);
  const to = RUNGS.findIndex((r) => r.value === rung);
  const stop = (i) => {
    if (i === to) return "eos-beat__stop eos-beat__stop--active eos-beat__stop--newest";
    if (i > to) return "eos-beat__stop eos-beat__stop--ahead";
    return i === at ? "eos-beat__stop eos-beat__stop--from" : "eos-beat__stop";
  };
  return (
    <div className="eos-needs-card eos-needs-offer">
      <div className="eos-beat eos-needs-ladder" aria-hidden="true">
        <ol className="eos-beat__line">
          {RUNGS.map((r, i) => (
            <li key={r.value} className={stop(i)}>
              <span className="eos-beat__mark">
                <span className="eos-beat__dot" />
                <span className="eos-beat__tag">{r.label}</span>
                <span className={i === to ? "eos-beat__word eos-beat__word--active" : "eos-beat__word"}>{i === at ? "Now" : i === to ? "Offered" : RUNG_WORDS[r.value]}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="eos-sr">
        <span>{rungLabel(from)}</span><span aria-hidden="true"> → </span><strong>{rungLabel(rung)}</strong>
      </p>
      {streak > 0 && (
        <p className="eos-needs-streak eos-needs-card__class">
          <Streak of={Math.max(streak, OFFER_AFTER)} done={streak} />
          <span>{streak} in a row went out as written.</span>
        </p>
      )}
    </div>
  );
}
