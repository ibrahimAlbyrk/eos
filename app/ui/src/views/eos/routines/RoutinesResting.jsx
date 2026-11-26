import { setRoutineState } from "../../../state/eos/routinesStore.js";
import { Section } from "../frame.jsx";
import { openLocation } from "../nav/eosNav.js";
import { RoutineGlyph } from "./RoutineGlyph.jsx";
import { word } from "./tableWords.js";

// Routines with none running, as a first step back: said as Home greets,
// then the paused ones on hairlines, each with Resume, and the way to the
// archived ones when there are some.
export function RoutinesResting({ list, showArchived }) {
  const paused = list.filter((r) => r.state === "paused");
  const archived = list.filter((r) => r.state === "archived").length;
  const line = paused.length > 0
    ? "Each of your routines is paused or archived."
    : "Each of your routines is archived.";
  return (
    <div className="eos-first eos-first--resting">
      <header className="eos-first__head">
        <p className="eos-label">Routines</p>
        <h2 className="eos-first__ask">Nothing active.</h2>
        <p className="eos-first__dim">{line}</p>
      </header>
      {paused.length > 0 && (
        <Section
          id="eos-resting-paused"
          label="Paused"
          aside={archived > 0 && <button type="button" className="eos-link" onClick={showArchived}>{word(archived)} archived</button>}
        >
          <ul className="eos-first__list">
            {paused.map((routine) => (
              <li key={routine.id} className="eos-first__rest">
                <button type="button" className="eos-first__row" onClick={() => openLocation(`eos:/routines/${encodeURIComponent(routine.id)}`)}>
                  <span className="eos-rtable__mark eos-rtable__mark--warn" aria-hidden="true">
                    <RoutineGlyph icon={routine.icon} name={routine.name} size={14} part="eos-rtable" />
                  </span>
                  <span className="eos-first__words">
                    <span className="eos-first__say">{routine.name}</span>
                    {routine.summary && <span className="eos-first__line">{routine.summary}</span>}
                  </span>
                </button>
                <button type="button" className="eos-btn" aria-label={`Resume ${routine.name}`} onClick={() => void setRoutineState(routine.id, "active")}>Resume</button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {paused.length === 0 && archived > 0 && (
        <div className="eos-rlead__acts eos-first__acts"><button type="button" className="eos-btn" onClick={showArchived}>Show archived</button></div>
      )}
    </div>
  );
}
