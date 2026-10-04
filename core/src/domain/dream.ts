// Dreaming rules — pure. When a nightly dream is due, how a chat is rendered for
// the recall pass (event-id tagged, secrets scrubbed, budgeted), and how the
// model's JSON becomes proposals the memory service can accept. Anything that
// doesn't validate is counted and dropped, never half-applied.

import type { MessageRole } from "./message-normalize.ts";
import {
  DreamConsolidateOutputSchema, DreamRecallOutputSchema,
  type DreamConsolidateOutput, type DreamObservation, type DreamProposalDraft,
} from "../../../contracts/src/dream.ts";
import type { UserMemory, UserMemoryScope } from "../../../contracts/src/profile.ts";

export const DREAM_CHAT_CHARS = 24_000;
const AGENT_LINE_CHARS = 600;

// ---- schedule ---------------------------------------------------------------

// The most recent HH:MM (local time) at or before `now`.
export function nightlySlot(now: number, nightlyAt: string): number {
  const [h, m] = nightlyAt.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h ?? 3, m ?? 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function nextNightly(now: number, nightlyAt: string): number {
  const d = new Date(nightlySlot(now, nightlyAt));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Due once the clock passed tonight's slot and nothing started since — a Mac asleep
// at 03:00 dreams when it wakes. `since` = the last run's start, or when Dreaming
// was turned on (so enabling it in the afternoon doesn't dream at once).
export function isNightlyDue(now: number, nightlyAt: string, since: number): boolean {
  return since < nightlySlot(now, nightlyAt);
}

// Away: no user message for `awayMinutes`, nothing working, and no dream yet since
// the user was last active — one dream per away stretch.
export function isAwayDue(
  now: number, awayMinutes: number, lastUserAt: number, anyWorking: boolean, lastStartedAt: number,
): boolean {
  return !anyWorking && now - lastUserAt >= awayMinutes * 60_000 && lastStartedAt < lastUserAt;
}

// ---- which chats ------------------------------------------------------------

// A top-level chat — where the user talks — as the dream sees it.
export interface DreamSession {
  readonly workerId: string;
  readonly name: string;
  readonly project: string | null;
  readonly noFolder: boolean;
  readonly working: boolean;
  readonly lastEventId: number;
}

export interface DreamChatFilter {
  readonly maxChats: number;
  readonly excludedProjects: readonly string[];
  readonly includeNoFolder: boolean;
  readonly excludedChats: ReadonlySet<string>;
  readonly watermark: (workerId: string) => number;
}

// Finished chats with something new since the last dream, newest first.
export function pickChats(sessions: readonly DreamSession[], f: DreamChatFilter): DreamSession[] {
  const excludedProject = (p: string | null): boolean =>
    p !== null && f.excludedProjects.some((x) => p === x || p.startsWith(`${x.replace(/\/+$/, "")}/`));
  return sessions
    .filter((s) => !s.working && !f.excludedChats.has(s.workerId))
    .filter((s) => (s.noFolder ? f.includeNoFolder : !excludedProject(s.project)))
    .filter((s) => s.lastEventId > f.watermark(s.workerId))
    .sort((a, b) => b.lastEventId - a.lastEventId)
    .slice(0, f.maxChats);
}

// ---- secrets ----------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/gi,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
}

// ---- rendering --------------------------------------------------------------

export interface DreamLine {
  readonly id: number;
  readonly role: MessageRole;
  readonly text: string;
}

export interface RenderedDreamChat {
  readonly text: string;
  readonly userTurns: number;
  // eventId → the scrubbed line, for turning evidence ids back into quotes.
  readonly lines: ReadonlyMap<number, DreamLine>;
}

// The user's words in full, the agent's trimmed; other roles carry no signal about
// the user. Over budget, the oldest lines go first.
export function renderChatForDream(messages: readonly DreamLine[], budget = DREAM_CHAT_CHARS): RenderedDreamChat {
  const kept: { line: DreamLine; rendered: string }[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const raw = scrubSecrets(m.text.trim());
    if (!raw) continue;
    const body = clip(raw, m.role === "user" ? budget : AGENT_LINE_CHARS);
    const rendered = `[e${m.id}] ${m.role === "user" ? "USER" : "AGENT"}: ${body}`;
    if (used + rendered.length > budget && kept.length) break;
    kept.push({ line: { id: m.id, role: m.role, text: body }, rendered });
    used += rendered.length + 1;
  }
  kept.reverse();
  return {
    text: kept.map((k) => k.rendered).join("\n"),
    userTurns: kept.filter((k) => k.line.role === "user").length,
    lines: new Map(kept.map((k) => [k.line.id, k.line])),
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

// ---- model output -----------------------------------------------------------

// The first JSON object in the reply (models wrap it in prose or fences).
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseRecall(text: string): DreamObservation[] {
  const r = DreamRecallOutputSchema.safeParse(extractJson(text));
  return r.success ? r.data.observations : [];
}

export function parseConsolidation(text: string): DreamConsolidateOutput | null {
  const r = DreamConsolidateOutputSchema.safeParse(extractJson(text));
  return r.success ? r.data : null;
}

export interface CheckedProposal {
  readonly draft: DreamProposalDraft;
  readonly scope: UserMemoryScope;
  readonly targets: readonly string[];
}

export interface ProposalCheck {
  readonly accepted: readonly CheckedProposal[];
  readonly invalid: number;
  readonly secret: number;
}

// What each kind needs to be applied safely: targets that exist and are kept, a
// project the dream actually read, the scope the change lands in.
export function checkProposals(
  drafts: readonly DreamProposalDraft[], memories: readonly UserMemory[], projects: readonly string[],
): ProposalCheck {
  const kept = new Map(memories.filter((m) => m.status === "active").map((m) => [m.id, m]));
  const accepted: CheckedProposal[] = [];
  let invalid = 0;
  let secret = 0;
  for (const d of drafts) {
    if (looksSecret(d.text)) { secret++; continue; }
    const scope = scopeFor(d, kept, projects);
    if (!scope) { invalid++; continue; }
    accepted.push({ draft: d, scope, targets: d.kind === "new" ? [] : [...new Set(d.targets)] });
  }
  return { accepted, invalid, secret };
}

function scopeFor(d: DreamProposalDraft, kept: ReadonlyMap<string, UserMemory>, projects: readonly string[]): UserMemoryScope | null {
  const targets = [...new Set(d.targets)].map((id) => kept.get(id));
  if (targets.some((t) => !t)) return null;
  const t = targets as UserMemory[];
  switch (d.kind) {
    case "new":
      if (d.scope === "global") return { kind: "global" };
      return d.project && projects.includes(d.project) ? { kind: "project", path: d.project } : null;
    case "update":
    case "retire":
      return t.length === 1 ? t[0]!.scope : null;
    case "promote":
      return t.length === 1 && t[0]!.scope.kind === "project" ? { kind: "global" } : null;
    case "merge": {
      if (t.length < 2) return null;
      const first = t[0]!.scope;
      const same = t.every((m) => m.scope.kind === first.kind && (m.scope.kind === "global" || (first.kind === "project" && m.scope.path === first.path)));
      return same ? first : { kind: "global" };
    }
  }
}
