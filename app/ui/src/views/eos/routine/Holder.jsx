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

// Which Mac runs the routine, shown only while it runs on another one:
// "Runs on MacBook Air", and once that Mac has been away two hours,
// "away since Tuesday" with Move here.
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
    <div className={away ? "eos-band eos-band--warn" : "eos-band"} role="status">
      <span className="eos-band__text">
        Runs on {holder.name}{away && `, away since ${sinceWord(holder.awaySince)}`}
      </span>
      {away && <button type="button" className="eos-btn eos-btn--primary" onClick={() => setMoving(true)}>Move here</button>}
      {moving && <MoveDialog routine={routine} holder={holder} onClose={() => setMoving(false)} />}
    </div>
  );
}
