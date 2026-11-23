// What a sentence typed at Home asks for, by rules alone, in the same render
// as the keystroke (08 §4.4). The same rules as the core's
// (`eos-domain/src/routine/intent.rs`), held to the same vectors
// (`fixtures/routines/intent-vectors.json`): a forced mode or a picked
// routine decides; a named routine with change words is a change, and with
// an item its routine takes, a run; an item exactly one routine recognises
// is a run of it; repetition or condition words make a routine; the bare
// name of a routine runs it on its latest. Anything else is not certain,
// and the choices say what it might be.

export const CHOICES_MAX = 3;

const WORD = /[\p{L}\p{N}]/u;

// The routine rows' patterns, compiled once per pattern text.
const compiled = new Map();
function regex(pattern) {
  if (!compiled.has(pattern)) {
    let re = null;
    try {
      re = new RegExp(pattern);
    } catch {}
    compiled.set(pattern, re);
  }
  return compiled.get(pattern);
}

// The first part of `text` one of the routine's item patterns matches.
export function itemIn(routine, text) {
  for (const pattern of routine.takes?.itemPatterns ?? []) {
    const found = regex(pattern)?.exec(text);
    if (found) return found[0].trim();
  }
  return null;
}

// `lower` holds `phrase` as whole words.
function holds(lower, phrase) {
  const p = phrase.trim().toLowerCase();
  if (!p) return false;
  for (let at = lower.indexOf(p); at !== -1; at = lower.indexOf(p, at + 1)) {
    const before = [...lower.slice(0, at)].pop();
    const after = [...lower.slice(at + p.length)][0];
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) return true;
  }
  return false;
}

const namesOf = (routine) => [routine.name, routine.slug, ...(routine.aliases ?? [])].filter(Boolean);
const names = (routine, lower) => namesOf(routine).some((n) => holds(lower, n));

function isName(routine, lower) {
  const bare = lower.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return namesOf(routine).some((n) => n !== "" && bare === n.toLowerCase());
}

const CHANGE_WORDS = ["should also", "should not", "shouldn't", "should", "stop", "never", "change", "no longer", "don't", "instead"];
const changes = (lower) => CHANGE_WORDS.some((w) => holds(lower, w));

const REPEAT_WORDS = [
  "every", "whenever", "each morning", "each evening", "each day", "each week", "each month", "daily", "weekly",
  "monthly", "nightly", "hourly", "each time", "any time", "when a", "when an", "if a", "if an", "mondays",
  "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays", "weekdays",
];
const AT_TIME = /\b(at|by) \d{1,2}(:\d{2})?\s*(am|pm)?\b/;
const ON_DAY = /\bon (monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/;
const repeats = (lower) => REPEAT_WORDS.some((w) => holds(lower, w)) || AT_TIME.test(lower) || ON_DAY.test(lower);

const choice = (intent, routine = null, item = null) => ({
  intent,
  routineId: routine && (intent === "run" || intent === "change") ? routine.id : null,
  item: intent === "run" ? item : null,
});

function sure(intent, routine, item) {
  return { ...choice(intent, routine, item), certain: true, alternatives: [choice(intent === "once" ? "make" : "once")] };
}

// Not sure: a run of each routine the text names or whose item it holds,
// then making a routine and doing it once, at most CHOICES_MAX.
function unsure(candidates, haystack) {
  const choices = [];
  for (const routine of candidates) {
    if (!choices.some((c) => c.routineId === routine.id)) choices.push(choice("run", routine, itemIn(routine, haystack)));
  }
  choices.push(choice("make"), choice("once"));
  return { intent: "unsure", certain: false, routineId: null, item: null, alternatives: choices.slice(0, CHOICES_MAX) };
}

// Reads { text, attachments (values), forced, routineId } against the
// routine rows (each { id, name, slug, aliases, takes: { itemPatterns } }).
// → { intent, certain, routineId, item, alternatives: [{ intent, routineId, item }] }.
export function readIntent({ text, attachments = [], forced = null, routineId = null }, routines) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const haystack = [trimmed, ...attachments].join(" ");
  const picked = routineId ? routines.find((r) => r.id === routineId) ?? null : null;
  const named = routines.filter((r) => names(r, lower));
  const routine = picked ?? (named.length === 1 ? named[0] : null);
  const itemOf = (r) => itemIn(r, haystack);
  const recognising = routines.filter((r) => itemOf(r) !== null);

  if (forced && forced !== "unsure") {
    const target = routine ?? (forced === "run" && recognising.length === 1 ? recognising[0] : null);
    if ((forced === "run" || forced === "change") && !target) return unsure([...named, ...recognising], haystack);
    return sure(forced, target, target ? itemOf(target) : null);
  }
  if (picked) return sure(changes(lower) ? "change" : "run", picked, itemOf(picked));
  if (routine) {
    if (changes(lower)) return sure("change", routine, null);
    const item = itemOf(routine);
    if (item !== null) return sure("run", routine, item);
  }
  if (recognising.length === 1) return sure("run", recognising[0], itemOf(recognising[0]));
  if (repeats(lower)) return sure("make", null, null);
  if (routine && isName(routine, lower)) return sure("run", routine, null);
  return unsure([...named, ...recognising], haystack);
}
