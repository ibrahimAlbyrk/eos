// A subagent as the lists read it: collectSubagents' entry without the bodies
// (prompt, report, inner tools' inputs and outputs). The core answers this
// shape for the whole conversation (GET /workers/:id/subagents, see
// crates/eos-contracts/src/subagents.rs); the transcript's own window is
// put in the same shape, so the two can be joined. Keep the three in step.

export const ACTIVITY_TEXT_MAX = 200;

// The first `max` UTF-16 units of `text`; a surrogate pair the cut would split
// is left out whole.
function cutText(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

// The plain values of a tool's input: what the list words a running tool from.
export function activityInput(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = cutText(value, ACTIVITY_TEXT_MAX);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

// The tool a running run is on (or ran last) — subagentActivity's pick.
function activityOf(run) {
  if (run.status !== "running") return null;
  const tools = run.tools ?? [];
  const tool = tools.findLast((t) => t.running) ?? tools.at(-1);
  return tool ? { name: tool.name, input: activityInput(tool.input) } : null;
}

export function summarizeRun(run) {
  const tools = run.tools ?? [];
  return {
    toolUseId: run.toolUseId,
    description: run.description,
    resumeOf: run.resumeOf ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    subagentType: run.subagentType ?? null,
    status: run.status,
    background: run.background,
    usage: run.usage ?? null,
    endTs: run.endTs ?? null,
    ts: run.ts,
    toolCount: tools.length,
    lastToolTs: tools.at(-1)?.ts ?? null,
    activity: activityOf(run),
  };
}

// One collectSubagents entry in summary shape (identity left out: it follows
// from the list's order, see subagentIdentity.js).
export function summarizeSubagent(subagent) {
  return { ...summarizeRun(subagent), runs: subagent.runs.map(summarizeRun) };
}
