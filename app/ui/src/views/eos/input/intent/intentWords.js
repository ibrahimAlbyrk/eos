// The words of the intent line (08 §4.4, RunIntent.dc.html): what Enter will
// do, said from the routine's own row (what it takes, where its result goes).

export const IDLE_HINT = "Click a routine around the input, drop a file on one, or just type.";
// Before the first routine there is nothing around the input to click.
export const FIRST_HINT = "Say what Eos should take care of, or drop a file here.";
export const MENU_LINE = "Pick a routine";
export const MAKE_LINE = "Make a new routine. You see its blueprint and a trial first";
export const ONCE_LINE = "Do it once, here. Nothing is sent. You can keep it as a routine afterwards";
export const UNSURE_LINE = "Which one?";
export const READING_LINE = "Reading…";
export const DECIDING_LINE = "Deciding…";
export const FAILED_LINE = "Couldn't decide. Pick one:";
export const TAB_HINT = "Tab for other choices";

// The verbs of the force menu (08 G11): Auto lets the rules decide.
export const VERBS = [
  { intent: null, label: "Auto", line: "Eos reads what you mean" },
  { intent: "run", label: "Run", line: "Start one of your routines" },
  { intent: "make", label: "Make", line: "Make a new routine from it" },
  { intent: "once", label: "Once", line: "Do it once, here" },
  { intent: "change", label: "Change", line: "Change one of your routines" },
];

const RUNG_WORDS = {
  ask: "asks before sending",
  draft: "draft for you",
  send_then_tell: "sends, then tells you",
  on_its_own: "on its own",
};

const takesNothing = (takes) => !takes || takes.kind === "none";

// "on #470", "on the latest pull request", or nothing for a routine that
// takes no item.
function onWhat(routine, item) {
  if (item) return ` on ${item}`;
  if (takesNothing(routine.takes)) return "";
  return ` on the latest ${routine.takes.label ?? "item"}`;
}

// "Run PR Review on #470, deep, shown to you only": the item (or the
// latest), what the user changed, where the result goes, and any `tail`
// (a later time, the cost of several).
export function runLine(routine, item, { result = "usual", detail = null, tail = null } = {}) {
  const where = result === "showOnly" ? "shown to you only" : result === "ask" ? RUNG_WORDS.ask : RUNG_WORDS[routine.rung];
  const parts = [`Run ${routine.name}${onWhat(routine, item)}`, detail, where, tail].filter(Boolean);
  return parts.join(", ");
}

// The line of one choice ({ intent, routineId, item }); `byId` holds the
// routine rows. A choice for a routine the dashboard does not know falls
// back to the core's own `line`.
export function choiceLine(c, byId) {
  const routine = c.routineId ? byId.get(c.routineId) : null;
  if (c.intent === "make") return MAKE_LINE;
  if (c.intent === "once") return ONCE_LINE;
  if (c.intent === "run" && routine) return runLine(routine, c.item);
  if (c.intent === "change" && routine) return `Change ${routine.name}. You confirm the new version`;
  return c.line ?? UNSURE_LINE;
}

// The short label of a choice on its button.
export function choiceLabel(c, byId) {
  const routine = c.routineId ? byId.get(c.routineId) : null;
  if (c.intent === "make") return "Make a routine";
  if (c.intent === "once") return "Do it once";
  if (c.intent === "change" && routine) return `Change ${routine.name}`;
  if (c.intent === "run" && routine) return `Run ${routine.name}${c.item ? ` on ${c.item}` : ""}`;
  return c.line ?? UNSURE_LINE;
}
