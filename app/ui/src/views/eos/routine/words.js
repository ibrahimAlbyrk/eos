// What the routine page says for a routine's words: why it is paused, and
// that its triggers wait.

const PAUSED = {
  user: "Paused by you.",
  failures: "Paused after three failed runs in a row.",
  spend: "Paused after a run cost far more than usual.",
  sign_in: "Paused: a sign-in it needs no longer works.",
  capability: "Paused: a capability it needs is missing or broken.",
};

export const pausedLine = (reason) => PAUSED[reason] ?? "Paused.";

// A routine whose When names a trigger; triggers do not start runs yet (P3).
export const hasTrigger = (detail) => (detail.head?.blueprint?.when?.on?.length ?? 0) > 0 || Boolean(detail.routine.triggerLine);

export const UNTIL_TRIGGERS = "Runs when you start it, until triggers arrive";
