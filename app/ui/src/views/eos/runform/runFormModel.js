// The run form's rules, with no React in them (08 §4.7): the form a routine
// opens with, its options split into the inline ones and "More", the item
// checked against what the routine takes, the estimate in words, the body
// POST /api/runs takes, and the line a same-item refusal shows.

export const INLINE_MAX = 3;
// 01's limit on one start.
export const ITEMS_MAX = 20;

export const RESULTS = [
  { value: "usual", label: "As usual" },
  { value: "ask", label: "Ask before sending" },
  { value: "showOnly", label: "Show me only" },
];

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const numberWord = (n) => NUMBERS[n] ?? String(n);
const plural = (n, word) => `${numberWord(n)} ${word}${n === 1 ? "" : "s"}`;

// Every option the routine takes: the blueprint's when it is read, else the
// row's (which carries only the inline ones).
export function optionsOf(routine, blueprint) {
  return Array.isArray(blueprint?.options) ? blueprint.options : routine.options ?? [];
}

// At most three options in the form itself, those the blueprint marks inline
// first; the rest behind "More".
export function splitOptions(options) {
  const flagged = options.filter((o) => o.inline);
  const inline = flagged.slice(0, INLINE_MAX);
  return { inline, more: options.filter((o) => !inline.includes(o)) };
}

const defaultsOf = (options) => Object.fromEntries(options.map((o) => [o.key, o.default]));

// The form a routine opens with: the blueprint's defaults, or what an earlier
// run was given (Run again). An earlier run's time is kept only while it is
// still ahead. A routine that takes several holds even one item among its
// items.
export function initialForm(options, input, now, many = false) {
  const given = input?.options ?? {};
  const known = Object.fromEntries(Object.entries(given).filter(([key]) => options.some((o) => o.key === key)));
  return {
    item: many ? null : input?.item ?? null,
    items: input?.items ?? (many && input?.item ? [input.item] : []),
    text: "",
    options: { ...defaultsOf(options), ...known },
    note: input?.note ?? "",
    result: input?.result ?? "usual",
    at: input?.at != null && input.at > now ? input.at : null,
  };
}

// The item the user typed, as the start takes it: a link, else text.
export function typedItem(text, takes) {
  const t = text.trim();
  if (!t) return null;
  const item = /^https?:\/\//i.test(t) ? { kind: takes.kind, url: t } : { kind: takes.kind, text: t };
  return { ...item, title: t, untrusted: false };
}

function matchesAny(patterns, text) {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(text);
    } catch {
      return false;
    }
  });
}

const article = (word) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

// Whether the routine takes an item at all.
export const takesItems = (takes) => Boolean(takes) && takes.kind !== "none";

// The items the run is given, in the order chosen, typed text last.
export function chosenItems(form, takes) {
  if (!takesItems(takes)) return [];
  const typed = typedItem(form.text, takes);
  const picked = takes.many ? form.items : form.item ? [form.item] : [];
  return typed ? [...picked, typed] : picked;
}

// Why the form cannot start yet, in words, or null.
export function formProblem(form, routine, now) {
  const takes = routine.takes;
  if (takesItems(takes)) {
    const typed = form.text.trim();
    const patterns = takes.itemPatterns ?? [];
    if (typed && patterns.length > 0 && !matchesAny(patterns, typed)) return `${routine.name} takes ${article(takes.label)}.`;
    const items = chosenItems(form, takes);
    if (items.length > ITEMS_MAX) return `At most ${ITEMS_MAX} at once.`;
    if (items.length > 1 && !takes.many) return `${routine.name} takes one ${takes.label} at a time.`;
    if (items.length === 0 && takes.empty === "required") return `Choose ${article(takes.label)}.`;
  }
  if (form.at != null && form.at <= now) return "Pick a time later than now.";
  return null;
}

function inputOf(form, options, items, chat) {
  const defaults = defaultsOf(options);
  const changed = Object.fromEntries(Object.entries(form.options).filter(([key, value]) => value !== defaults[key]));
  const note = form.note.trim();
  return {
    ...(items.length === 1 ? { item: items[0] } : {}),
    options: changed,
    ...(note ? { note } : {}),
    result: form.result,
    ...(form.at != null ? { at: form.at } : {}),
    ...(chat ? { chat } : {}),
  };
}

// The body of POST /api/runs: one item in the input, several as `items` (one
// run each). Options are sent only where they differ from their default.
export function startBody(routine, options, form, { door, chat, clientRequestId, confirmRepeat = false, againOf }) {
  const items = chosenItems(form, routine.takes);
  return {
    routineId: routine.id,
    input: inputOf(form, options, items, chat),
    ...(items.length > 1 ? { items } : {}),
    ...(againOf ? { againOf } : {}),
    door,
    ...(confirmRepeat ? { confirmRepeat: true } : {}),
    clientRequestId,
  };
}

// The body of POST /api/runs/estimate for what the form holds now.
export function estimateBody(routine, options, form) {
  const items = chosenItems(form, routine.takes);
  return { routineId: routine.id, input: inputOf(form, options, items.slice(0, 1)), count: Math.max(1, items.length) };
}

// How long, in words: "under a minute", "five minutes", "about an hour".
export function timeWords(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "an hour" : plural(hours, "hour");
}

const dollars = (usd) => `$${usd.toFixed(2)}`;

// Who runs: "A deep run" when an inline choice is set, "A run" otherwise.
function runWord(form, inline) {
  const choice = inline.find((o) => o.type === "choice" && typeof form.options[o.key] === "string");
  return choice ? `A ${form.options[choice.key].toLowerCase()} run` : "A run";
}

// The estimate in words (D7): with an API key time and dollars, on a Claude
// plan time only. `estimate` is the core's answer for the form as it is, or
// the routine's usual cost while its options are the defaults; its dollars
// are for all `count` runs. The answer's own `n` is how many past runs it was
// taken over, not how many will run.
export function estimateLine(estimate, { form, inline, plan, count = 1 }) {
  if (!estimate || !(estimate.ms > 0)) return null;
  const n = Math.max(1, count);
  const time = timeWords(estimate.ms);
  if (n === 1) {
    const cost = plan ? "" : ` and ${dollars(estimate.usd)}`;
    return `${runWord(form, inline)} usually takes about ${time}${cost}.`;
  }
  const cost = plan ? "" : ` and ${dollars(estimate.usd)} in all`;
  const runs = plural(n, "run");
  return `${runs.charAt(0).toUpperCase()}${runs.slice(1)} usually take about ${time} each${cost}.`;
}

// The routine's usual cost stands in for an estimate only while every
// option is its default.
export function usualEstimate(routine, options, form, count) {
  if (!routine.usual) return null;
  const defaults = defaultsOf(options);
  if (Object.entries(form.options).some(([key, value]) => value !== defaults[key])) return null;
  return { usd: routine.usual.usd * count, ms: routine.usual.ms };
}

// Bills by the run: the Claude account's own key, not its plan (D7).
export function billsByRun(accounts) {
  return accounts?.find((a) => a.id === "anthropic")?.route === "api_key";
}

function agoWords(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  return `${plural(Math.floor(minutes / 60), "hour")} ago`;
}

const ENDED = new Set(["done", "skipped", "cancelled", "failed"]);

// What a 409 same-item refusal says, from the earlier run: still at work
// (shown first, so a second run is a choice made with the first in view), or
// when it ran and whether at the same version of the item.
export function repeatLine(routine, earlier, now) {
  if (!ENDED.has(earlier.run.state)) return `${routine.name} is working on this now.`;
  const version = earlier.input?.item?.version ? " at the same commit" : "";
  return `${routine.name} ran on this ${agoWords(now - earlier.run.createdAt)}${version}.`;
}

export const isLive = (earlier) => !ENDED.has(earlier.run.state);

// A short name for an item on a chip: its number when it has one.
export function chipLabel(item) {
  const number = /\/pull\/(\d+)/.exec(item.url ?? "")?.[1] ?? /#(\d+)/.exec(item.key ?? item.title ?? "")?.[1];
  if (number) return `#${number}`;
  const title = item.title ?? item.text ?? item.url ?? item.path ?? item.date ?? "Item";
  return title.length > 24 ? `${title.slice(0, 23)}…` : title;
}
