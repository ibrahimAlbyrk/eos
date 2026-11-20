// What Needs you says for the core's words: the groups of the list, each
// kind's primary action, and who answered an item elsewhere.

// The list's groups in order (08 §4.12); an item put aside is under Later
// whatever its kind. A kind not named here is a question for the user.
export const GROUPS = [
  { id: "send", label: "To check and send", kinds: ["draft"] },
  { id: "questions", label: "Questions" },
  { id: "problems", label: "Problems", kinds: ["routine_alert", "delivery_problem", "capability_attention", "notice"] },
  { id: "offers", label: "Offers", kinds: ["freedom_offer", "capability_install", "suggestion"] },
  { id: "later", label: "Later" },
];

export function groupOf(item) {
  if (item.state === "later") return "later";
  return GROUPS.find((g) => g.kinds?.includes(item.kind))?.id ?? "questions";
}

// Each kind's primary action in the list; it opens the item, where the
// answer is given with everything in view.
const PRIMARY = {
  draft: "Review",
  question: "Answer",
  permission: "Decide",
  run_start: "Decide",
  confirm_change: "Decide",
  about_you: "Decide",
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
