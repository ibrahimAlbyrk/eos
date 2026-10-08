// How the dream's data reads inside its prompts — pure. Every block is one item per
// line group, led by the id the model answers with (s<N>, dc-…, um-…, p<N>), with the
// user's own words quoted under it.

import { summarizeSupport, type NightSignal } from "./dream-ledger.ts";
import type { CheckedProposal } from "./dream.ts";
import type { DreamCandidate } from "../../../contracts/src/dream.ts";
import type { DreamEvidence, UserMemory } from "../../../contracts/src/profile.ts";

const MEMORY_LIST_MAX = 200;

const quote = (e: DreamEvidence): string => `    [e${e.eventId}] user: “${e.quote}”`;

// s<N> · object · stance · chat (project) [· marker] [· reason], the ask, its quotes.
export function formatSignals(night: readonly NightSignal[]): string {
  return night.map((n, i) => [
    [
      `s${i}`, n.signal.object, n.signal.stance, `chat ${n.chat} (${n.project ?? "no folder"})`,
      ...(n.signal.marker ? [`marker “${n.signal.marker}”`] : []),
      ...(n.signal.reason ? [`reason: ${n.signal.reason}`] : []),
    ].join(" · "),
    `  ${n.signal.ask}`,
    ...n.evidence.slice(0, 3).map(quote),
  ].join("\n")).join("\n") || "(none)";
}

// dc-… · seen in N chats on D days across P projects [· explicit] [· changes um-…],
// the claim; with `quotes`, the user's lines behind it.
export function formatCandidates(candidates: readonly DreamCandidate[], opts: { readonly quotes: boolean }): string {
  return candidates.map((c) => {
    const s = summarizeSupport(c);
    const head = [
      c.id, `seen in ${s.chats} chat${s.chats === 1 ? "" : "s"} on ${s.days} day${s.days === 1 ? "" : "s"} across ${s.projects} project${s.projects === 1 ? "" : "s"}`,
      ...(s.origin === "explicit" ? ["stated as a standing rule"] : []),
      ...(s.irreversible ? ["guards an irreversible action"] : []),
      ...(c.target ? [`would change kept memory ${c.target}`] : []),
    ].join(" · ");
    const lines = opts.quotes ? c.support.flatMap((x) => x.evidence).slice(-6).map(quote) : [];
    const reasons = opts.quotes ? [...new Set(c.support.map((x) => x.reason).filter(Boolean))].map((r) => `    reason given: ${r}`) : [];
    return [head, `  ${c.claim}`, ...reasons, ...lines].join("\n");
  }).join("\n") || "(none)";
}

// Kept memories first (they're what update/merge/promote/retire can target), then
// pending, then declined — the model must not propose those again.
export function formatMemories(memories: readonly UserMemory[]): string {
  const rank = { active: 0, suggested: 1, dismissed: 2 } as const;
  const label = { active: "kept", suggested: "pending", dismissed: "declined" } as const;
  return [...memories].sort((a, b) => rank[a.status] - rank[b.status]).slice(0, MEMORY_LIST_MAX)
    .map((m) => `${m.id} · ${label[m.status]} · ${m.scope.kind === "global" ? "global" : `project ${m.scope.path}`} · ${m.category}\n  ${m.text}`)
    .join("\n") || "(none yet)";
}

// p<N> · kind · scope [· targets], the text, why it matters, the lines it rests on.
export function formatProposals(proposals: readonly CheckedProposal[]): string {
  return proposals.map((p, i) => {
    const s = summarizeSupport(p.candidate);
    return [
      [
        `p${i}`, p.draft.kind, p.scope.kind === "global" ? "global" : `project ${p.scope.path}`,
        ...(p.targets.length ? [`changes ${p.targets.join(", ")}`] : []),
        `seen in ${s.chats} chats on ${s.days} days`, s.origin === "explicit" ? "stated as a standing rule" : "inferred",
      ].join(" · "),
      `  text: ${p.draft.text}`,
      `  why: ${p.draft.why}`,
      ...p.candidate.support.flatMap((x) => x.evidence).slice(-6).map(quote),
    ].join("\n");
  }).join("\n");
}
