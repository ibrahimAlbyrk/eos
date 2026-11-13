// A chat's conversation-wide lists — its subagents and the artifacts it
// published — in the shape the lists read (subagentSummary.js): from the
// loaded transcript window when it holds the whole conversation, else from
// the core's summaries of the whole conversation (GET /workers/:id/subagents,
// /artifacts) with the window's own derivation taking over what it shows. The
// window always holds the newest rows, so what it derives is never older than
// the summaries.

import { buildBlocks, applyClears, applyRewinds, applyRecalls } from "./messageParser.js";
import { collectSubagents } from "./subagentRuns.js";
import { assignIdentities } from "./subagentIdentity.js";
import { summarizeRun } from "./subagentSummary.js";

const withIdentity = (summary, identity) => ({ ...summary, identity });

// Full subagents (collectSubagents) in summary shape, identities kept.
export function summarizeAll(subagents) {
  return subagents.map((s) => ({
    ...withIdentity(summarizeRun(s), s.identity),
    runs: s.runs.map((r) => withIdentity(summarizeRun(r), r.identity)),
  }));
}

// Runs in summary shape → subagents, grouped as collectSubagents groups
// agentRuns: launch order, a run that continues another joining its subagent
// under the first run's id, type, description and identity.
export function groupRuns(runs) {
  const sorted = runs.slice().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const agents = [];
  const runsOf = new Map();
  for (const r of sorted) {
    let own = r.resumeOf && runsOf.get(r.resumeOf);
    if (!own) agents.push((own = []));
    own.push(r);
    runsOf.set(r.toolUseId, own);
  }
  const identities = assignIdentities(agents.map((own) => own[0].toolUseId));
  return agents.map((own) => {
    const [first] = own;
    const identity = identities.get(first.toolUseId);
    const runs = own.map((r) => ({ ...r, identity, description: first.description }));
    return { ...runs.at(-1), toolUseId: first.toolUseId, subagentType: first.subagentType, runs };
  });
}

// The core's subagents of the whole conversation, each run the window shows
// replaced by the window's own (fresher) one, the window's new runs added.
export function mergeSubagents(summaries, windowSubagents) {
  const fresh = new Map();
  for (const s of windowSubagents) for (const r of s.runs) fresh.set(r.toolUseId, summarizeRun(r));
  const runs = [];
  for (const s of summaries) {
    for (const r of s.runs) {
      const w = fresh.get(r.toolUseId);
      fresh.delete(r.toolUseId);
      // A window that starts after a run's earlier one cannot tell what it continues.
      runs.push(w ? { ...w, resumeOf: w.resumeOf ?? r.resumeOf } : r);
    }
  }
  runs.push(...fresh.values());
  return groupRuns(runs);
}

// The core's artifacts of the whole conversation with the window's: a page the
// window shows keeps its first link and title and takes the window's latest
// activity. Newest activity first.
export function mergeArtifacts(summaries, windowArtifacts) {
  const byKey = new Map(summaries.map((a) => [a.slug ?? a.url, a]));
  for (const a of windowArtifacts) {
    const key = a.slug ?? a.url;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { url: prev.url, slug: a.slug, title: prev.title ?? a.title, ts: a.ts } : a);
  }
  return [...byKey.values()].sort((a, b) => b.ts - a.ts);
}

// One subagent, whole (prompt, report, every tool), from the rows that rebuild
// it (GET /workers/:id/subagents/:callId/events); null when they hold none.
export function subagentFromRows(rows, callId) {
  const blocks = buildBlocks(applyRecalls(applyRewinds(applyClears(rows), { bootPromptOffset: 0 })));
  return collectSubagents(blocks).find((s) => s.runs.some((r) => r.toolUseId === callId)) ?? null;
}
