// Pure helpers for Dreaming in the UI: what each proposal kind is called and does,
// which memories are a dream's proposals (vs an agent's suggestions), the old text
// a change replaces, and the short status lines the rail, Settings and log show.

import { projectLabel } from "./memoryGroups.js";

export const KIND_META = {
  new: { label: "New", keep: "Keep", kicker: "Something agents don't know yet" },
  update: { label: "Update", keep: "Update it", kicker: "A kept memory drifted from how you work now" },
  merge: { label: "Merge", keep: "Merge them", kicker: "Overlapping memories become one" },
  promote: { label: "Promote", keep: "Promote", kicker: "A project habit that holds everywhere" },
  retire: { label: "Retire", keep: "Retire it", kicker: "No longer true — agents would be misled" },
};
export const KIND_ORDER = ["new", "update", "merge", "promote", "retire"];

export const CONFIDENCE_LABEL = { 1: "Tentative", 2: "Likely", 3: "Strong" };

export const MODEL_OPTIONS = [
  { value: "opus", label: "Opus · default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
export const modelLabel = (m) => ({ opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" })[m] ?? m;

export const proposalKind = (m) => m.proposal?.kind ?? "new";
export const isDreamProposal = (m) => m.status === "suggested" && m.source?.kind === "dream";
export const isAgentSuggestion = (m) => m.status === "suggested" && m.source?.kind !== "dream";
export const evidenceOf = (m) => (m.source?.kind === "dream" ? m.source.evidence : []);

// Pending dream proposals, in the order a review walks them: by kind, newest first.
export function dreamProposals(memories) {
  return (memories ?? []).filter(isDreamProposal)
    .sort((a, b) => KIND_ORDER.indexOf(proposalKind(a)) - KIND_ORDER.indexOf(proposalKind(b)) || b.createdAt - a.createdAt);
}

export function kindCounts(proposals) {
  return KIND_ORDER.map((kind) => ({ kind, label: KIND_META[kind].label, count: proposals.filter((p) => proposalKind(p) === kind).length }))
    .filter((k) => k.count > 0);
}

// The kept memories a change rewrites, merges or retires (gone ones left out).
export function targetsOf(m, memories) {
  const byId = new Map((memories ?? []).map((x) => [x.id, x]));
  return (m.proposal?.targets ?? []).map((id) => byId.get(id)).filter(Boolean);
}

// "eos → All projects" for a promote; the scope it lands in otherwise.
export function scopeLine(m, memories) {
  if (proposalKind(m) === "promote") {
    const from = targetsOf(m, memories)[0];
    return from?.scope.kind === "project" ? `${projectLabel(from.scope.path)} → All projects` : "All projects";
  }
  return m.scope.kind === "project" ? projectLabel(m.scope.path) : "All projects";
}

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "today 03:00" / "tonight 03:00" / "yesterday 02:40" / "Oct 3 · 02:40".
export function fmtDreamTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const day = (x) => new Date(x).setHours(0, 0, 0, 0);
  const diff = Math.round((day(ts) - day(now)) / 86_400_000);
  if (diff === 0) return `${ts > now && d.getHours() >= 18 ? "tonight" : "today"} ${hhmm(d)}`;
  if (diff === 1) return `${d.getHours() < 6 || d.getHours() >= 18 ? "tonight" : "tomorrow"} ${hhmm(d)}`;
  if (diff === -1) return `yesterday ${hhmm(d)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hhmm(d)}`;
}

export function runSummary(run) {
  if (!run) return "";
  if (run.status === "skipped" || run.status === "failed") return run.reason ?? run.status;
  const parts = [`${run.chatsRead} ${run.chatsRead === 1 ? "chat" : "chats"}`, `${run.proposed} ${run.proposed === 1 ? "proposal" : "proposals"}`];
  if (run.status === "stopped") parts.push("stopped early");
  return parts.join(" · ");
}

// The one line that says where Dreaming stands right now.
export function dreamStatusLine(status, settings, now = Date.now()) {
  if (!status) return "";
  if (status.running) {
    const p = status.progress;
    return p?.chat ? `Dreaming… reading chat ${Math.min(p.done + 1, p.total)} of ${p.total}` : "Dreaming…";
  }
  if (!settings?.enabled) return "Off";
  if (status.blocked === "sign-in") return "Needs a Claude sign-in";
  if (settings.schedule === "manual") return "Only when you ask";
  if (settings.schedule === "away") return `While you're away · after ${settings.awayMinutes} min`;
  return status.nextAt ? `Next: ${fmtDreamTime(status.nextAt, now)}` : `Every night at ${settings.nightlyAt}`;
}

export const DROPPED_LABELS = [
  ["oneOff", "One task's detail"],
  ["known", "Already known (memory, profile or CLAUDE.md)"],
  ["declined", "You dismissed it before"],
  ["weak", "Not enough evidence"],
  ["secret", "Looked like a secret — never stored"],
  ["invalid", "Didn't fit — dropped"],
];

export const droppedTotal = (run) => DROPPED_LABELS.reduce((n, [k]) => n + (run?.dropped?.[k] ?? 0), 0);
