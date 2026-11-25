import { useEffect, useState } from "react";
import { holderOf, loadRunners, useRunners } from "../../../state/eos/runnersStore.js";
import { MoveDialog } from "./MoveDialog.jsx";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" });

// "Tuesday" within the last week, "March 3" before.
export function sinceWord(at, now = Date.now()) {
  return now - at < WEEK_MS ? weekday.format(new Date(at)) : date.format(new Date(at));
}

const MAC = "M3.5 4h9v6.5h-9zM1.5 12.5h13";

// Which Mac runs the routine, shown only while it runs on another one, as a
// fact under the lead: "Runs on MacBook Air", and once that Mac has been
// away two hours, "away since Tuesday" in warn with Move here.
export function HolderLine({ routine }) {
  const { runners } = useRunners();
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    void loadRunners();
  }, [routine.id]);
  const holder = holderOf(runners, routine.id);
  if (!holder) return null;
  const away = holder.awaySince != null;
  return (
    <div className={away ? "eos-holder eos-holder--away" : "eos-holder"} role="status">
      <svg className="eos-holder__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={MAC} /></svg>
      <span className="eos-holder__text">
        Runs on {holder.name}{away && `, away since ${sinceWord(holder.awaySince)}`}
      </span>
      {away && <button type="button" className="eos-btn eos-btn--primary" onClick={() => setMoving(true)}>Move here</button>}
      {moving && <MoveDialog routine={routine} holder={holder} onClose={() => setMoving(false)} />}
    </div>
  );
}
