// Pure helpers over the parser's agentRun blocks (one per Claude subagent): who
// they are (identity), how a launch batch reads in the transcript, and how long
// each one worked. Shared by the transcript line, the Subagents side-panel tab
// and the Environment popover so all three tell the same story.

import { assignIdentities } from "./subagentIdentity.js";
import { fmtElapsedShort } from "./format.js";

// Every agentRun in spawn order, each carrying its identity ({ color, hex, glyph }).
export function collectSubagents(blocks) {
  const runs = blocks
    .filter((b) => b.kind === "agentRun")
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const identities = assignIdentities(runs.map((r) => r.toolUseId));
  return runs.map((r) => ({ ...r, identity: identities.get(r.toolUseId) }));
}

// Consecutive agentRun blocks are one launch batch → one "subagents" block that
// renders as a single line. `subagents` (from collectSubagents) supplies the
// identity-carrying version of each run.
export function groupSubagentRuns(blocks, subagents) {
  const byId = new Map(subagents.map((r) => [r.toolUseId, r]));
  const out = [];
  for (const b of blocks) {
    if (b.kind !== "agentRun") {
      out.push(b);
      continue;
    }
    const run = byId.get(b.toolUseId) ?? b;
    const prev = out[out.length - 1];
    if (prev?.kind === "subagents") prev.runs.push(run);
    else out.push({ kind: "subagents", runs: [run], ts: b.ts });
  }
  return out;
}

export const isRunning = (run) => run.status === "running";

// Active in launch order; finished ones most recent first.
export function splitByStatus(runs) {
  const active = runs.filter(isRunning);
  const done = runs
    .filter((r) => !isRunning(r))
    .sort((a, b) => (b.endTs ?? b.ts ?? 0) - (a.endTs ?? a.ts ?? 0));
  return { active, done };
}

// "A, B and C" — the text after the i-th of n names.
export function nameSeparator(i, n) {
  if (i < n - 2) return ", ";
  if (i === n - 2) return " and ";
  return " ";
}

export function launchVerb(runs) {
  return runs.some(isRunning) ? "started working" : "finished";
}

// Working time: live while running; for a finished one the lane's own figure
// when it reported one, else start → end (or → its last tool). null = unknown.
export function subagentElapsedMs(run, now) {
  if (isRunning(run)) return Math.max(0, now - run.ts);
  if (run.usage?.durationMs) return run.usage.durationMs;
  const lastToolTs = run.tools?.length ? run.tools[run.tools.length - 1].ts : null;
  const end = run.endTs ?? lastToolTs;
  return end != null && end > run.ts ? end - run.ts : null;
}

const PHRASES = {
  running: ["Working for", "Working"],
  completed: ["Worked for", "Finished"],
  failed: ["Failed after", "Failed"],
  stopped: ["Stopped after", "Stopped"],
};

// "Worked for 34s" / "Failed after 3s" / "Finished" when the time is unknown.
export function subagentStatusPhrase(run, now) {
  const [timed, bare] = PHRASES[run.status] ?? PHRASES.completed;
  const ms = subagentElapsedMs(run, now);
  return ms != null ? `${timed} ${fmtElapsedShort(ms)}` : bare;
}

// Claude Code appends a <usage>…</usage> footer to a subagent's result — noise
// for a reader.
export function cleanSubagentResult(text) {
  return (text ?? "").replace(/<usage>[\s\S]*?<\/usage>\s*/g, "").trim();
}
