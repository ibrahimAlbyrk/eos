// Dreaming rules — pure. When a nightly dream is due, how a chat is rendered for
// the recall pass (event-id tagged, secrets scrubbed, budgeted), which recall
// signals may become memories at all, the writing rules a memory must follow, and
// how the model's answers become proposals the memory service can accept. Anything
// that doesn't validate is counted and dropped, never half-applied. The candidate
// ledger lives in dream-ledger.ts.

import type { MessageRole } from "./message-normalize.ts";
import { candidateScope } from "./dream-ledger.ts";
import {
  DreamConsolidateOutputSchema, DreamCriticOutputSchema, DreamMatchOutputSchema, DreamRecallOutputSchema,
  type DreamCandidate, type DreamConsolidateOutput, type DreamDropped, type DreamMatchGroup, type DreamProposalDraft,
  type DreamRejected, type DreamSignal, type DreamVerdict,
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
  // When it was said (the event's timestamp).
  readonly at: number;
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
    kept.push({ line: { id: m.id, role: m.role, text: body, at: m.at }, rendered });
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

export function emptyDreamDropped(): DreamDropped {
  return {
    oneOff: 0, known: 0, declined: 0, secret: 0, weak: 0, invalid: 0,
    product: 0, taskBound: 0, choice: 0, critic: 0, style: 0, capped: 0,
  };
}

// The model answers through a schema-checked tool, so these are a last check that
// also applies the schemas' defaults and trimming.
export function parseRecall(answer: unknown): DreamSignal[] {
  const r = DreamRecallOutputSchema.safeParse(answer);
  return r.success ? r.data.signals : [];
}

export function parseMatch(answer: unknown): DreamMatchGroup[] | null {
  const r = DreamMatchOutputSchema.safeParse(answer);
  return r.success ? r.data.groups : null;
}

export function parseConsolidation(answer: unknown): DreamConsolidateOutput | null {
  const r = DreamConsolidateOutputSchema.safeParse(answer);
  return r.success ? r.data : null;
}

export function parseCritic(answer: unknown): DreamVerdict[] | null {
  const r = DreamCriticOutputSchema.safeParse(answer);
  return r.success ? r.data.verdicts : null;
}

// ---- which signals can become memories ------------------------------------------

export interface SignalFilter {
  readonly kept: DreamSignal[];
  readonly product: number;
  readonly taskBound: number;
  readonly choice: number;
}

// Only how the agent should work with the user, or who the user is. What the
// product does belongs to the code and docs; one task's step belongs to that task;
// accepting an option the agent offered says nothing about the user.
export function filterSignals(signals: readonly DreamSignal[]): SignalFilter {
  const kept: DreamSignal[] = [];
  let product = 0;
  let taskBound = 0;
  let choice = 0;
  for (const s of signals) {
    if (s.object === "artifact" || s.object === "project-convention" || s.stance === "product-feedback") product++;
    else if (s.stance === "task-instruction") taskBound++;
    else if (s.stance === "choice") choice++;
    else kept.push(s);
  }
  return { kept, product, taskBound, choice };
}

// ---- writing rules ------------------------------------------------------------------

export const MEMORY_WORDS_MAX = 40;
const OPENING = /^(When|Whenever|Before|After|If|While|The user)\b/;
const HEDGE = /\b(often|usually|tends? to|sometimes|generally|typically)\b/i;
const SHOUT = /\b(MUST|NEVER|ALWAYS|IMPORTANT|CRITICAL)\b/;

// Why a memory's text breaks the format agents follow best — a rule that opens with
// its situation, or a fact about the user — or null when it's fine.
export function lintMemoryText(text: string): string | null {
  const t = text.trim();
  if (t.split(/\s+/).length > MEMORY_WORDS_MAX) return `longer than ${MEMORY_WORDS_MAX} words`;
  if (!OPENING.test(t)) return "doesn't open with its situation (When…, Before…) or \"The user…\"";
  const hedge = HEDGE.exec(t);
  if (hedge) return `hedges with "${hedge[0]}" instead of naming the situation`;
  if (SHOUT.test(t)) return "shouts in capitals";
  return null;
}

// ---- proposals ------------------------------------------------------------------------

export interface CheckedProposal {
  readonly draft: DreamProposalDraft;
  readonly candidate: DreamCandidate;
  readonly scope: UserMemoryScope;
  readonly targets: readonly string[];
}

export interface ProposalCheck {
  readonly accepted: readonly CheckedProposal[];
  readonly invalid: number;
  readonly secret: number;
  readonly style: number;
  readonly rejected: readonly DreamRejected[];
}

// What each proposal needs to be applied safely: a ready candidate behind it,
// targets that exist and are kept, text that follows the writing rules, and the
// scope it lands in (a new memory's comes from where its support was seen).
export function checkProposals(
  drafts: readonly DreamProposalDraft[], memories: readonly UserMemory[], ready: readonly DreamCandidate[],
): ProposalCheck {
  const kept = new Map(memories.filter((m) => m.status === "active").map((m) => [m.id, m]));
  const candidates = new Map(ready.map((c) => [c.id, c]));
  const accepted: CheckedProposal[] = [];
  const rejected: DreamRejected[] = [];
  let invalid = 0;
  let secret = 0;
  let style = 0;
  for (const d of drafts) {
    const candidate = candidates.get(d.candidate);
    if (!candidate) { invalid++; continue; }
    if (looksSecret(d.text)) { secret++; continue; }
    const lint = d.kind === "retire" ? null : lintMemoryText(d.text);
    if (lint) { style++; rejected.push({ text: d.text, reason: `Writing: ${lint}` }); continue; }
    const scope = scopeFor(d, candidate, kept);
    if (!scope) { invalid++; continue; }
    accepted.push({ draft: d, candidate, scope, targets: d.kind === "new" ? [] : [...new Set(d.targets)] });
  }
  return { accepted, invalid, secret, style, rejected };
}

function scopeFor(d: DreamProposalDraft, candidate: DreamCandidate, kept: ReadonlyMap<string, UserMemory>): UserMemoryScope | null {
  const targets = [...new Set(d.targets)].map((id) => kept.get(id));
  if (targets.some((t) => !t)) return null;
  const t = targets as UserMemory[];
  switch (d.kind) {
    case "new":
      return candidateScope(candidate);
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

export interface CriticOutcome {
  readonly kept: readonly CheckedProposal[];
  readonly rejected: readonly DreamRejected[];
}

// The critic must vouch for each proposal: kept only when it says so AND at least
// one cited line actually says it (a retire rests on the change, not a quote). No
// verdict means refuted.
export function applyVerdicts(proposals: readonly CheckedProposal[], verdicts: readonly DreamVerdict[]): CriticOutcome {
  const kept: CheckedProposal[] = [];
  const rejected: DreamRejected[] = [];
  proposals.forEach((p, i) => {
    const v = verdicts.find((x) => x.proposal === i);
    const grounded = p.draft.kind === "retire" || Boolean(v?.quotes.some((q) => q.says === "yes"));
    if (v?.keep && grounded) kept.push(p);
    else rejected.push({ text: p.draft.text, reason: refutation(v, grounded) });
  });
  return { kept, rejected };
}

// The critic's five tests (prompts/dream/critic-system), by number.
const TEST_NAMES = ["", "about the product, not the user", "one task's step", "an agent would do it anyway", "not a well-written rule", "like something you declined"];

function refutation(v: DreamVerdict | undefined, grounded: boolean): string {
  if (!v) return "The critic gave no verdict";
  if (v.keep && !grounded) return "No cited line actually says it";
  const fails = v.fails.map((n) => TEST_NAMES[n]).filter(Boolean).join("; ");
  return [v.reason, fails && `(${fails})`].filter(Boolean).join(" ") || "Refuted";
}
