import { openLocation } from "../nav/eosNav.js";
import { awayText, clockOf } from "./homeWords.js";

// "While you were away" (or, when nothing ended since the visit, "Earlier
// today"): one line per routine, newest first; Open shows the run.
export function AwayList({ runs, names, title = "While you were away" }) {
  if (runs.length === 0) return null;
  return (
    <section className="eos-home-part" aria-labelledby="eos-home-away">
      <h2 id="eos-home-away" className="eos-label">{title}</h2>
      <ul className="eos-away">
        {runs.map((run) => (
          <li key={run.id} className="eos-away__line">
            <span className="eos-away__time">{clockOf(run.endedAt)}</span>
            <span className="eos-away__routine">{names[run.routineId] ?? "A routine"}</span>
            <span className="eos-away__text">{awayText(run)}</span>
            <button type="button" className="eos-link" onClick={() => openLocation(`eos:/runs/${encodeURIComponent(run.id)}`)}>Open</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
