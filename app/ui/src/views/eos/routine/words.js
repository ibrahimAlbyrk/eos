// What the routine page says for a routine's words: why it is paused, how far
// its results go without the user, and its blueprint's slots in plain words.

const PAUSED = {
  user: "Paused by you.",
  failures: "Paused after three failed runs in a row.",
  spend: "Paused after a run cost far more than usual.",
  sign_in: "Paused: a sign-in it needs no longer works.",
  capability: "Paused: a capability it needs is missing or broken.",
};

export const pausedLine = (reason) => PAUSED[reason] ?? "Paused.";

const RUNGS = {
  ask: "Asks before it starts",
  draft: "You send",
  send_then_tell: "Sends, then tells you",
  on_its_own: "On its own",
};

export const rungWord = (rung) => RUNGS[rung] ?? rung;

// A routine whose When names a trigger; triggers do not start runs yet (P3).
export const hasTrigger = (detail) => (detail.head?.blueprint?.when?.on?.length ?? 0) > 0 || Boolean(detail.routine.triggerLine);

export const UNTIL_TRIGGERS = "Runs when you start it, until triggers arrive";

function recipient(r) {
  if (r.kind === "me") return "You";
  if (r.kind === "fixed") return r.address;
  return "Where the item came from";
}

// The blueprint's seven slots as label and value, read-only; a slot the
// blueprint leaves empty says so.
export function slotRows(routine, blueprint) {
  const bp = blueprint ?? {};
  const or = (value) => (value ? value : "Not set");
  return [
    { label: "Takes", value: or(bp.takes?.label ?? routine.takes?.label) },
    { label: "When", value: routine.triggerLine ?? "When you run it" },
    { label: "Who", value: or(bp.who?.agents?.map((a) => a.name).join(", ")) },
    { label: "How", value: or(bp.how?.steps?.join(" · ")) },
    { label: "Makes", value: or(bp.makes?.description) },
    { label: "Goes to", value: or(bp.goesTo?.map(recipient).join(", ")) },
    { label: "Freedom", value: rungWord(bp.freedom?.rung ?? routine.rung) },
  ];
}
