import { buildLocation, openLocation } from "../nav/eosNav.js";
import { clockOf, whenWords } from "./homeWords.js";

// What runs next (Main.dc.html's open space under the day): a strip of the
// soonest slots, each hung from a hairline like a mark on the horizon; one
// opens its routine. With nothing scheduled it says so in one quiet line.
export function ComingUp({ slots, names, now }) {
  return (
    <section className="eos-home-part" aria-labelledby="eos-home-next">
      <h2 id="eos-home-next" className="eos-label">Coming up</h2>
      {slots.length === 0 ? (
        <p className="eos-home-quiet">Nothing is scheduled to run.</p>
      ) : (
        <ol className="eos-next">
          {slots.map((slot) => (
            <li key={slot.routineId} className="eos-next__slot">
              <button type="button" className="eos-next__open" onClick={() => openLocation(buildLocation({ screen: "routine", routineId: slot.routineId }))}>
                <span className="eos-next__when">{whenWords(slot.at, now)}</span>
                <span className="eos-next__clock">{clockOf(slot.at)}</span>
                <span className="eos-next__name">{names[slot.routineId] ?? "A routine"}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
