// What the intent line shows and what Enter may act on, from the rules'
// reading and the core's (08 §4.4). Enter never acts on a guess: only a
// certain reading, or a choice the user moved to with Tab.

export const MAKE_CHOICE = { intent: "make", routineId: null, item: null };
export const ONCE_CHOICE = { intent: "once", routineId: null, item: null };
// "Couldn't decide": making, doing it once, or the routine menu.
export const MENU_CHOICE = { intent: "menu", routineId: null, item: null };

const runChoices = (reading) => reading.alternatives.filter((c) => c.intent === "run").length;

// Whether the core must be asked: the rules are not sure and name fewer than
// two routines (two or more are shown as choices with no model).
export function needsCore(local) {
  return !local.certain && runChoices(local) < 2;
}

// → { kind: "idle" | "menu" | "sure" | "choices" | "waiting" | "failed",
//     reading?, slow? }. `asked` is the core's state for the current text.
export function verdictOf({ text, things = [], routineId = null, local, asked }) {
  const trimmed = text.trim();
  if (trimmed === "" && things.length === 0 && !routineId) return { kind: "idle" };
  if (trimmed.startsWith("/")) return { kind: "menu" };
  if (local.certain) return { kind: "sure", reading: local };
  if (!needsCore(local)) return { kind: "choices", reading: local };
  if (asked.status === "answered") return { kind: asked.reading.certain ? "sure" : "choices", reading: asked.reading };
  if (asked.status === "failed") return { kind: "failed", reading: { alternatives: [MAKE_CHOICE, ONCE_CHOICE, MENU_CHOICE] } };
  return { kind: "waiting", slow: asked.status === "slow" };
}

// What Tab cycles through: a certain reading first, then its alternatives;
// while unsure, the choices.
export function optionsOf(verdict) {
  if (verdict.kind === "sure") return [verdict.reading, ...verdict.reading.alternatives];
  if (verdict.kind === "choices" || verdict.kind === "failed") return verdict.reading.alternatives;
  return [];
}

// The choice Enter acts on now, or null.
export function actionable(verdict, input) {
  const options = optionsOf(verdict);
  if (verdict.kind === "sure") return options[input.tab % options.length];
  if ((verdict.kind === "choices" || verdict.kind === "failed") && input.tabbed) return options[input.tab % options.length];
  return null;
}
