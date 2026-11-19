// What the blueprint editor says: the cost line under the card, a refused
// blueprint's findings, who made a version.

const usd = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

// "Uses github. About $0.38 a pull request, stops at $5 a day."
export function costLine(routine, bp) {
  const sentences = [];
  const needs = (bp.needs ?? []).filter((n) => typeof n === "string");
  if (needs.length) sentences.push(`Uses ${needs.join(", ")}.`);
  const unit = bp.takes?.label && bp.takes.kind !== "none" ? bp.takes.label : "run";
  const each = routine?.usual?.usd != null ? `About ${usd(routine.usual.usd)} a ${unit}` : bp.limits?.perRunUsd != null ? `At most ${usd(bp.limits.perRunUsd)} a run` : null;
  const day = bp.limits?.perDayUsd != null ? `stops at ${usd(bp.limits.perDayUsd)} a day` : null;
  if (each && day) sentences.push(`${each}, ${day}.`);
  else if (each || day) sentences.push(`${each ?? day.charAt(0).toUpperCase() + day.slice(1)}.`);
  return sentences.join(" ");
}

// A finding of the blueprint's rules: where, and what is wrong.
export const issueLine = (issue) => (issue.path?.length ? `${issue.path.join(" › ")}: ${issue.message}` : issue.message);

const AUTHORS = { user: "you", restore: "you", once: "you", architect: "by talking", eos: "suggested", sync: "from another Mac" };

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
