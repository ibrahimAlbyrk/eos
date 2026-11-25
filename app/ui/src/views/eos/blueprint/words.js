// What the blueprint editor says: the cost line under the card, a refused
// blueprint's findings, who made a version.

const andList = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

const usd = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

// "Uses GitHub and Unity docs. About $0.38 a pull request, stops at $5 a
// day." A capability is named by its name once `capabilities` holds it.
export function costLine(routine, bp, capabilities = []) {
  const sentences = [];
  const needs = (bp.needs ?? []).filter((n) => typeof n === "string").map((id) => capabilities.find((c) => c.id === id)?.name ?? id);
  if (needs.length) sentences.push(`Uses ${andList(needs)}.`);
  const unit = bp.takes?.label && bp.takes.kind !== "none" ? bp.takes.label : "run";
  const each = routine?.usual?.usd != null ? `About ${usd(routine.usual.usd)} a ${unit}` : bp.limits?.perRunUsd != null ? `At most ${usd(bp.limits.perRunUsd)} a run` : null;
  const day = bp.limits?.perDayUsd != null ? `stops at ${usd(bp.limits.perDayUsd)} a day` : null;
  if (each && day) sentences.push(`${each}, ${day}.`);
  else if (each || day) sentences.push(`${each ?? day.charAt(0).toUpperCase() + day.slice(1)}.`);
  return sentences.join(" ");
}

// A finding of the blueprint's rules: where, and what is wrong.
export const issueLine = (issue) => (issue.path?.length ? `${issue.path.join(" › ")}: ${issue.message}` : issue.message);

const AUTHORS = { user: "you", restore: "you", once: "you", architect: "by talking", eos: "suggested", sync: "from another Mac", import: "from a file" };

export const authorWord = (author) => AUTHORS[author] ?? author;

export function versionDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// A blueprint the user fills by hand: one worker, results to the user as a
// draft; the core fills the limits it leaves out.
export const HAND_BLUEPRINT = {
  format: 1,
  name: "New routine",
  summary: "",
  icon: "doc",
  aliases: [],
  kind: "standing",
  takes: { kind: "none", label: "nothing", placeholder: "", empty: "none", many: false },
  options: [],
  when: { on: [] },
  which: {},
  who: {
    depth: "solo",
    agents: [{ key: "worker", name: "Worker", lead: true, brief: "", model: "sonnet", effort: "medium", tools: { allow: [], deny: [] }, readsOutside: false, workspace: "none" }],
    checker: { model: "sonnet", effort: "low" },
  },
  how: { steps: [], checks: [], format: "", checkAgent: false },
  makes: { kind: "text", description: "" },
  goesTo: [{ id: "me", kind: "me", channel: "notify" }],
  freedom: { rung: "draft", grants: [] },
};

// A new routine's first step: sentences to start from (a pick fills the
// input and never sends), and what each part of a blueprint is for.
export const NEW_STARTERS = [
  "Review my pull requests every morning",
  "Write me a morning paper from my feeds",
  "Sort my inbox and draft the replies",
  "Tell me when the build breaks",
];

export const SLOT_GUIDE = [
  ["Takes", "What each run works on: a pull request, a message, or nothing."],
  ["When", "What starts it: a time, something that happens, or you."],
  ["Which", "Which of those it picks up, and which it leaves."],
  ["Who", "The agents that do the work, and the models they use."],
  ["How", "The steps they follow and the checks before anything leaves."],
  ["Makes", "What a run hands back: a review, a page, a draft."],
  ["Goes to", "Where the result goes: to you, a channel, a pull request."],
  ["Freedom", "How much it may do on its own before it asks you."],
];

// What a slot is for, said where it holds nothing yet.
export const slotHint = (label) => SLOT_GUIDE.find(([name]) => name === label)?.[1];
