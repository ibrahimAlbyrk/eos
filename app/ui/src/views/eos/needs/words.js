// What Needs you says for the core's words: the groups of the list, each
// kind's primary action, and who answered an item elsewhere.

// The list's groups in order (08 §4.12); an item put aside is under Later
// whatever its kind. A kind not named here is a question for the user.
export const GROUPS = [
  { id: "send", label: "To check and send", kinds: ["draft"] },
  { id: "questions", label: "Questions" },
  { id: "problems", label: "Problems", kinds: ["routine_alert", "delivery_problem", "capability_attention", "notice"] },
  // A guess Eos made about the user asks nothing of a run: it is not a question.
  { id: "about", label: "About you", kinds: ["about_you"] },
  { id: "offers", label: "Offers", kinds: ["freedom_offer", "capability_install", "suggestion"] },
  { id: "later", label: "Later" },
];

export function groupOf(item) {
  if (item.state === "later") return "later";
  return GROUPS.find((g) => g.kinds?.includes(item.kind))?.id ?? "questions";
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

// The list's lead: how many wait now; those put aside are counted apart.
export function needsLead(items) {
  const open = items.filter((i) => i.state !== "later").length;
  const later = items.length - open;
  if (open === 0) return later === 1 ? "One thing waits for later." : `${WORDS[later] ?? later} things wait for later.`;
  return open === 1 ? "One thing needs you." : `${WORDS[open] ?? open} things need you.`;
}

// Each kind's primary action in the list; it opens the item, where the
// answer is given with everything in view.
const PRIMARY = {
  draft: "Review",
  question: "Answer",
  permission: "Decide",
  run_start: "Decide",
  confirm_change: "Decide",
  about_you: "Check it",
  freedom_offer: "Decide",
  delivery_problem: "Fix",
};

export const primaryAction = (kind) => PRIMARY[kind] ?? "Open";

// Items Eos shows without keeping (a run's ask, a suggestion about the user)
// are answered only through their own routes: they cannot be put aside or
// discarded.
export const isShownOnly = (id) => id.startsWith("perm:") || id.startsWith("sugg:");

const DEVICES = { phone: "your iPhone", peer: "your other Mac", dashboard: "this Mac" };

// Why an item no longer waits, in words: answered on which device, replaced,
// expired or withdrawn.
export function closedLine({ state, answeredBy }) {
  if (state === "replaced") return "Replaced by a newer draft.";
  if (state === "expired") return "This expired before anyone answered it.";
  if (state === "withdrawn") return "Withdrawn: what asked for it no longer needs it.";
  if (answeredBy === "system") return "Eos answered this on its own.";
  return DEVICES[answeredBy] ? `Answered on ${DEVICES[answeredBy]}.` : "Answered elsewhere.";
}


// Why a draft needs Send anyway: the core's reason ("3 new commits").
export function staleLine(reason) {
  return reason ? `${reason} since this draft. Check it before you send it.` : "Its subject moved on since this draft. Check it before you send it.";
}

// The seconds a send in its hold still waits.
export function secondsLeft(sendAt, now) {
  return `${Math.max(0, Math.ceil((sendAt - now) / 1000))} s left`;
}

// What became of a send, by its state or by what the user did to it here.
export const SEND_NOTES = {
  queued: "Waiting to send.",
  sending: "Sending now.",
  sent: "Sent.",
  undone: "Taken back.",
  partial: "Taken back. Some of it stays where it went.",
  cannot_undo: "Sent. It can no longer be taken back.",
  wrong: "Noted: that was wrong.",
};

// Each kind's glyph (16 viewBox), drawn in its ring in the list.
const GLYPH = {
  draft: "M2.5 8.2l11-5.2-3.6 10.5-2.3-4.4zM7.6 9.1l5.9-6.1",
  question: "M5.8 6.1a2.3 2.3 0 1 1 3.4 2c-.7.4-1.2.9-1.2 1.6v.5M8 12.2v.1",
  permission: "M8 2.5l5 2v3.6c0 3-2.2 4.9-5 5.7-2.8-.8-5-2.7-5-5.7V4.5z",
  routine_alert: "M6 4v8M10 4v8",
  delivery_problem: "M8 2.8l5.7 10H2.3zM8 6.8v2.8M8 11.3v.1",
  capability_attention: "M8 2.8l5.7 10H2.3zM8 6.8v2.8M8 11.3v.1",
  notice: "M4.2 11V7.6a3.8 3.8 0 0 1 7.6 0V11l1 1.4H3.2zM6.8 14h2.4",
  freedom_offer: "M8 13V3.5M4.5 7L8 3.5 11.5 7",
  capability_install: "M8 3v10M3 8h10",
  about_you: "M8 7.8a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM3.2 13.4c.6-2.3 2.5-3.6 4.8-3.6s4.2 1.3 4.8 3.6",
  run_start: "M5.5 3.8l7 4.2-7 4.2z",
  confirm_change: "M3.5 8.5l3 3 6-7",
};
export const kindGlyph = (kind) => GLYPH[kind] ?? GLYPH.notice;

// The tone an item's mark is lit in: what broke in its tone, what asks now
// in the accent, the rest plain.
const TONE = { routine_alert: "warn", capability_attention: "warn", delivery_problem: "err" };
export function itemTone(item) {
  if (item.state === "later") return undefined;
  return TONE[item.kind] ?? (item.attention === "interrupt" ? "active" : undefined);
}

const COUNTED = {
  send: ["a draft to send", (n) => `${WORDS[n]?.toLowerCase() ?? n} drafts to send`],
  questions: ["a question", (n) => `${WORDS[n]?.toLowerCase() ?? n} questions`],
  problems: ["a problem", (n) => `${WORDS[n]?.toLowerCase() ?? n} problems`],
  about: ["a guess about you", (n) => `${WORDS[n]?.toLowerCase() ?? n} guesses about you`],
  offers: ["an offer", (n) => `${WORDS[n]?.toLowerCase() ?? n} offers`],
};

// The list's second line: what waits now, by group, in words ("A draft to
// send, three questions and a problem."); null when only Later holds any.
export function needsLine(items) {
  const parts = GROUPS.filter((g) => COUNTED[g.id]).map((g) => {
    const n = items.filter((i) => groupOf(i) === g.id).length;
    if (n === 0) return null;
    return n === 1 ? COUNTED[g.id][0] : COUNTED[g.id][1](n);
  }).filter(Boolean);
  if (parts.length === 0) return null;
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${said.slice(0, 1).toUpperCase()}${said.slice(1)}.`;
}
