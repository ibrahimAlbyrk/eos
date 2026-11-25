// The When slot (02's `When`) as words and the parts the user can change:
// each trigger said in words, a schedule's days, time and zone (D17: the
// zone it was made in, with one tap to the Mac's), and no cron line (D18).
// Every change keeps the keys this version does not know.

const DAYS = [
  { value: "all", label: "every day" },
  { value: "weekdays", label: "on weekdays" },
];
const WEEKDAYS = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const OUTCOMES = [
  { value: "done", label: "finishes" },
  { value: "delivered", label: "sends its result" },
  { value: "any", label: "ends in any way" },
];
const FOLDER_EVENTS = { added: "added", changed: "changed", removed: "removed" };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const daysLabel = (days) => DAYS.find((d) => d.value === days)?.label
  ?? (Array.isArray(days) ? `on ${days.map((d) => WEEKDAYS[d] ?? d).join(", ")}` : "every day");

const daysOptions = (days) => (DAYS.some((d) => d.value === days) ? DAYS : [...DAYS, { value: days, label: daysLabel(days) }]);

const list = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

// The parts of one schedule; `put` takes the trigger's new schedule.
function scheduleParts(s, put, n) {
  const days = { key: `${n}.days`, label: "Days", editor: "menu", text: daysLabel(s.days), value: s.days, options: daysOptions(s.days), apply: (days) => put({ ...s, days }) };
  const at = (field) => ({ key: `${n}.${field}`, label: "Time", editor: "text", text: s[field], value: s[field], check: (v) => TIME.test(v) || "A time such as 07:30", apply: (v) => put({ ...s, [field]: v }) });
  let parts;
  if (s.daily !== undefined) parts = ["Runs ", days, " at ", at("daily")];
  else if (s.every !== undefined) {
    const minutes = { key: `${n}.every`, label: "Minutes", editor: "text", text: `${s.every} minutes`, value: String(s.every), check: (v) => /^[1-9]\d*$/.test(v) || "A whole number of minutes", apply: (v) => put({ ...s, every: Number(v) }) };
    parts = ["Every ", minutes, s.between ? ` from ${s.between[0]} to ${s.between[1]} ` : " ", days];
  } else if (s.monthly !== undefined) {
    const day = { key: `${n}.monthly`, label: "Day of the month", editor: "text", text: s.monthly === "last" ? "last day" : `day ${s.monthly}`, value: String(s.monthly), check: (v) => v === "last" || (/^\d+$/.test(v) && v >= 1 && v <= 31) || "1 to 31, or last", apply: (v) => put({ ...s, monthly: v === "last" ? v : Number(v) }) };
    parts = ["On the ", day, " of each month at ", at("at")];
  } else parts = ["On a schedule this version cannot read"];
  const here = localZone();
  if (s.zone && s.zone !== here) {
    parts.push(` (${s.zone} time) `, { key: `${n}.zone`, label: `Use ${here} time`, editor: "act", text: `Use ${here}`, apply: () => put({ ...s, zone: here }) });
  }
  return parts;
}

// What a capability's trigger is about: the item a run takes when it is
// that source's ("A pull request is "), else the capability by its name and
// the source's words ("GitHub pulls: "), never its dotted id.
function sourceLead(source, { capabilities = [], takes } = {}) {
  const item = takes?.source === source && takes.label;
  if (item) return [`${/^[aeiou]/i.test(item) ? "An" : "A"} ${item} is `];
  const [id, ...rest] = source.split(".");
  const name = capabilities.find((c) => c.id === id)?.name;
  return [`${[name ?? id, ...rest].join(" ").replace(/[_-]/g, " ")}: `];
}

// The parts of trigger `n`; `put` takes its replacement.
function triggerParts(t, put, n, ctx) {
  const routines = ctx.routines;
  if (t.schedule) return scheduleParts(t.schedule, (schedule) => put({ ...t, schedule }), n);
  if (t.source) {
    const events = { key: `${n}.events`, label: "Events", editor: "text", text: (t.events ?? []).join(" or ") || "any event", value: (t.events ?? []).join(", "), apply: (v) => put({ ...t, events: list(v) }) };
    const scope = Object.entries(t.scope ?? {}).flatMap(([k, v]) => [" in ", { key: `${n}.scope.${k}`, label: k, editor: "text", text: v, value: v, apply: (next) => put({ ...t, scope: { ...t.scope, [k]: next } }) }]);
    return [...sourceLead(t.source, ctx), events, ...scope];
  }
  if (t.folder) {
    const f = t.folder;
    const putFolder = (patch) => put({ ...t, folder: { ...f, ...patch } });
    const parts = [
      "A file is ",
      { key: `${n}.folder.events`, label: "Events", editor: "text", text: (f.events ?? []).map((e) => FOLDER_EVENTS[e] ?? e).join(" or "), value: (f.events ?? []).join(", "), apply: (v) => putFolder({ events: list(v) }) },
      " in ",
      { key: `${n}.folder.path`, label: "Folder", editor: "text", text: f.path, value: f.path, apply: (v) => putFolder({ path: v }) },
    ];
    parts.push(" named ", { key: `${n}.folder.names`, label: "Names", editor: "glob", text: f.names ?? "anything", value: f.names ?? "", apply: (v) => putFolder({ names: v || undefined }) });
    return parts;
  }
  if (t.git) {
    const g = t.git;
    return [
      "New commits on ",
      { key: `${n}.git.branch`, label: "Branch", editor: "text", text: g.branch, value: g.branch, apply: (v) => put({ ...t, git: { ...g, branch: v } }) },
      " in ",
      { key: `${n}.git.repo`, label: "Repository", editor: "text", text: g.repo, value: g.repo, apply: (v) => put({ ...t, git: { ...g, repo: v } }) },
    ];
  }
  if (t.after) {
    const a = t.after;
    const options = (routines ?? []).map((r) => ({ value: r.id, label: r.name }));
    const name = options.find((o) => o.value === a.routine)?.label ?? "another routine";
    return [
      "After ",
      { key: `${n}.after.routine`, label: "Routine", editor: "menu", text: name, value: a.routine, options, apply: (v) => put({ ...t, after: { ...a, routine: v } }) },
      " ",
      { key: `${n}.after.outcome`, label: "Outcome", editor: "menu", text: OUTCOMES.find((o) => o.value === a.outcome)?.label ?? a.outcome, value: a.outcome, options: OUTCOMES, apply: (v) => put({ ...t, after: { ...a, outcome: v } }) },
    ];
  }
  return ["A trigger this version cannot read"];
}

// A trigger after " or " goes on the sentence: "or runs on weekdays".
function midSentence(parts) {
  const [first, ...rest] = parts;
  return typeof first === "string" ? [first.charAt(0).toLowerCase() + first.slice(1), ...rest] : parts;
}

// A new schedule, on the Mac's zone.
const NEW_SCHEDULE = () => ({ schedule: { daily: "09:00", days: "weekdays", zone: localZone() } });

export function whenParts(when, ctx = {}) {
  const w = when ?? { on: [] };
  const on = w.on ?? [];
  const putAt = (n) => (t) => ({ ...w, on: on.map((old, i) => (i === n ? t : old)) });
  const parts = on.length === 0 ? ["When you run it"] : on.flatMap((t, n) => [
    ...(n > 0 ? [" or "] : []),
    ...(n > 0 ? midSentence(triggerParts(t, putAt(n), n, ctx)) : triggerParts(t, putAt(n), n, ctx)),
    { key: `${n}.remove`, label: "Remove this trigger", editor: "act", text: "×", apply: () => ({ ...w, on: on.filter((_, i) => i !== n) }) },
  ]);
  parts.push(" ", { key: "add", label: "Add a schedule", editor: "act", text: "Add a schedule", add: true, apply: () => ({ ...w, on: [...on, NEW_SCHEDULE()] }) });
  return parts;
}
