import { useEffect, useState } from "react";
import { notify } from "../../../lib/notify.js";

// How long a notice stays before it goes by itself, by tone: what went wrong
// stays longest. Hovering or focusing the stack holds them.
const STAYS_MS = { info: 5000, warning: 8000, error: 12000 };
const MOST = 3;
const TONE = { info: "", warning: "warn", error: "err" };

// What an Eos screen was told while it shows (notify.*): one solid line each
// at the foot of the main column, newest last, its tone as the 9 px mark, the
// title strong and the words dim, Dismiss at the right. Nothing is drawn
// while there is nothing to say.
export function Notices() {
  const [shown, setShown] = useState([]);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let next = 0;
    return notify.listen((notice) => {
      next += 1;
      const id = next;
      setShown((all) => [...all, { ...notice, id }].slice(-MOST));
    });
  }, []);
  useEffect(() => {
    if (held || !shown.length) return undefined;
    const first = shown[0];
    const timer = setTimeout(() => setShown((all) => all.filter((n) => n.id !== first.id)), STAYS_MS[first.tone] ?? STAYS_MS.info);
    return () => clearTimeout(timer);
  }, [shown, held]);
  if (!shown.length) return null;
  const drop = (id) => setShown((all) => all.filter((n) => n.id !== id));
  return (
    <div className="eos-notices" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      {shown.map((n) => (
        <div key={n.id} className={TONE[n.tone] ? `eos-notice eos-notice--${TONE[n.tone]}` : "eos-notice"} role={n.tone === "error" ? "alert" : "status"}>
          <p className="eos-notice__words">
            {n.title && <strong>{n.title}</strong>}
            <span>{n.message}</span>
          </p>
          <button type="button" className="eos-notice__close" aria-label="Dismiss" onClick={() => drop(n.id)}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
