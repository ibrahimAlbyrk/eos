import { useState } from "react";

// When the run starts (08 G26): Now, or Later from a popover with Today,
// Tomorrow, or a date, and a time, in the Mac's own time zone.

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

export function LaterPicker({ at, onChange, now }) {
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("tomorrow");
  const [time, setTime] = useState(() => firstTime("tomorrow", now));
  const pick = (nextDay, nextTime = firstTime(nextDay, now)) => {
    setDay(nextDay);
    setTime(nextTime);
    onChange(laterAt(nextDay, nextTime, now));
  };
  return (
    <div className="eos-runform__row">
      <span className="eos-runform__label" id="runform-when">When</span>
      <div className="eos-seg" role="radiogroup" aria-labelledby="runform-when">
        <button type="button" role="radio" aria-checked={at == null} className="eos-seg__opt" onClick={() => { setOpen(false); onChange(null); }}>Now</button>
        <button type="button" role="radio" aria-checked={at != null} aria-expanded={open} className="eos-seg__opt" onClick={() => setOpen(!open)}>
          {at != null ? whenWords(at, now) : "Later"} ▾
        </button>
      </div>
      {open && (
        <div className="eos-runform__later" role="group" aria-label="Later">
          <button type="button" className="eos-btn" aria-pressed={day === "today" && at != null} onClick={() => pick("today")}>Today</button>
          <button type="button" className="eos-btn" aria-pressed={day === "tomorrow" && at != null} onClick={() => pick("tomorrow")}>Tomorrow</button>
          <input
            type="date"
            className="eos-runform__input"
            aria-label="Day"
            min={dayOf(new Date(now))}
            value={day === "today" || day === "tomorrow" ? dayOf(new Date(laterAt(day, time, now))) : day}
            onChange={(e) => e.target.value && pick(e.target.value, time)}
          />
          <input type="time" className="eos-runform__input" aria-label="Time" value={time} onChange={(e) => e.target.value && pick(day, e.target.value)} />
        </div>
      )}
    </div>
  );
}
