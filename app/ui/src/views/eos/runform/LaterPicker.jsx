import { useState } from "react";

// When the run starts (08 G26): Now, or Later with a day of the coming week
// and a time, in the Mac's own time zone.

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function plusDays(now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return dayOf(d);
}

// `day`: "today", "tomorrow" or YYYY-MM-DD; `time`: HH:MM → epoch ms, local.
export function laterAt(day, time, now) {
  const date = day === "today" ? dayOf(new Date(now)) : day === "tomorrow" ? plusDays(now, 1) : day;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

// "Today 14:00", "Tomorrow 09:00", else the day and the time.
export function whenWords(at, now) {
  const d = new Date(at);
  const day = dayOf(d);
  if (day === dayOf(new Date(now))) return `Today ${timeOf(d)}`;
  if (day === plusDays(now, 1)) return `Tomorrow ${timeOf(d)}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${timeOf(d)}`;
}

// The time Later offers first: the next full hour today, 09:00 another day.
export function firstTime(day, now) {
  if (day !== "today") return "09:00";
  const d = new Date(now);
  return `${pad(Math.min(23, d.getHours() + 1))}:00`;
}

// The days Later offers as chips: today, tomorrow and the two after, each
// named as the user reads it ("Sat 28").
function laterDays(now) {
  return Array.from({ length: 4 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const name = i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
    return { key: i === 0 ? "today" : i === 1 ? "tomorrow" : dayOf(d), name };
  });
}

export function LaterPicker({ at, onChange, now }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("tomorrow");
  const [time, setTime] = useState(() => firstTime("tomorrow", now));
  const pick = (nextDay, nextTime = firstTime(nextDay, now)) => {
    setDay(nextDay);
    setTime(nextTime);
    onChange(laterAt(nextDay, nextTime, now));
  };
  // Opening Later picks its first offer, so the choice that is lit is the one
  // that will happen.
  const openLater = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (at == null) pick(day, time);
  };
  return (
    <div className="eos-runform__row">
      <span className="eos-runform__label" id="runform-when">When</span>
      <div className="eos-seg" role="radiogroup" aria-labelledby="runform-when">
        <button type="button" role="radio" aria-checked={at == null} className="eos-seg__opt" onClick={() => { setOpen(false); onChange(null); }}>Now</button>
        <button type="button" role="radio" aria-checked={at != null} aria-expanded={open} className="eos-seg__opt" onClick={openLater}>
          {at != null ? whenWords(at, now) : "Later"} ▾
        </button>
      </div>
      {open && (
        <div className="eos-runform__later" role="group" aria-label="Later">
          <div className="eos-runform__days">
            {laterDays(now).map((d) => (
              <button key={d.key} type="button" className="eos-chip eos-runform__day" aria-pressed={day === d.key && at != null} onClick={() => pick(d.key, d.key === day ? time : undefined)}>
                {d.name}
              </button>
            ))}
          </div>
          <label className="eos-runform__at">
            <span>at</span>
            <input type="time" className="eos-runform__time" aria-label="Time" value={time} onChange={(e) => e.target.value && pick(day, e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
}
