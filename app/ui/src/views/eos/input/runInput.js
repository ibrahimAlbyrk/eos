// The Home input with a routine token (08 §4.4, RunInput.dc.html): the text
// is the item slot, the inline options and Result sit in the controls row,
// and the intent line says the run Enter starts. Pure: the input keeps the
// form and passes it in. The run form's own rules (runFormModel.js) check
// the item and build the start.

import { whenWords } from "../runform/LaterPicker.jsx";
import {
  chipLabel, chosenItems, formProblem, initialForm, optionsOf, splitOptions, takesItems, timeWords,
} from "../runform/runFormModel.js";
import { runLine } from "./intent/intentWords.js";

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (word) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

// The form a routine starts with at Home, with `text` in its item slot.
export function homeForm(routine, text = "", now = Date.now()) {
  return withText(routine, initialForm(optionsOf(routine), null, now, Boolean(routine.takes?.many)), text);
}

// The form with the slot's text: the item typed, or for a routine that
// takes no item, the run's note.
export function withText(routine, form, text) {
  return takesItems(routine.takes) ? { ...form, text } : { ...form, text: "", note: text };
}

// The slot's placeholder: "Number, link, or empty for the latest".
export function slotHint(takes) {
  if (!takesItems(takes)) return "A note for this run, or empty";
  const what = takes.itemPatterns?.length ? "Number, link" : capital(takes.label ?? "item");
  return takes.empty === "latest" ? `${what}, or empty for the latest` : what;
}

// The inline choices the user moved off their default: "deep".
function changedWords(routine, form) {
  const { inline } = splitOptions(optionsOf(routine));
  return inline
    .filter((o) => o.type === "choice" && form.options[o.key] !== undefined && form.options[o.key] !== o.default)
    .map((o) => String(form.options[o.key]).toLowerCase())
    .join(", ") || null;
}

function itemsWord(routine, items) {
  if (items.length === 0) return null;
  if (items.length === 1) return chipLabel(items[0]);
  const label = routine.takes.label ?? "item";
  return `${NUMBERS[items.length] ?? items.length} ${label}s`;
}

// What Enter does with the token: { text, enter }. `plan`: the user pays by
// a Claude plan, so no dollars are said (D7).
export function tokenLine(routine, form, { now = Date.now(), plan = true } = {}) {
  const takes = routine.takes;
  const typed = form.text.trim();
  const patterns = takes?.itemPatterns ?? [];
  if (takesItems(takes) && typed && patterns.length && formProblem(form, routine, now)?.endsWith(`takes ${article(takes.label)}.`)) {
    return { text: `Not ${article(takes.label)}. ${slotHint(takes)}`, enter: false };
  }
  const problem = formProblem(form, routine, now);
  if (problem) return { text: problem, enter: false };
  const items = chosenItems(form, takes);
  const cost = items.length > 1 && !plan && routine.usual ? `about $${(routine.usual.usd * items.length).toFixed(2)}` : null;
  const later = form.at != null ? whenWords(form.at, now).replace(/^./, (c) => c.toLowerCase()) : null;
  const text = runLine(routine, itemsWord(routine, items), {
    result: form.result,
    detail: changedWords(routine, form),
    tail: [later, cost].filter(Boolean).join(", ") || null,
  });
  return { text, enter: true };
}

// Under the candidates: "Usually three minutes and about $0.40 a run."
export function usualLine(routine, plan = true) {
  if (!routine.usual?.ms) return null;
  const cost = plan ? "" : ` and about $${routine.usual.usd.toFixed(2)}`;
  return `Usually ${timeWords(routine.usual.ms)}${cost} a run.`;
}
