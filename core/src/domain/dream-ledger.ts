// The dream's candidate ledger — pure. A candidate is something that may become a
// memory once it has shown up enough. Support is counted by OCCASION (a chat on a
// day), never by mentions: saying the same thing four times inside one task is one
// occasion. A candidate is ready when the user stated it as a standing rule, when it
// came back in separate chats on separate days, or when it guards a public or
// irreversible action. Unreinforced candidates fade.

import type {
  DreamCandidate, DreamMatchGroup, DreamSignal, DreamSupport,
} from "../../../contracts/src/dream.ts";
import type { DreamEvidence, DreamSupportSummary, UserMemory, UserMemoryScope } from "../../../contracts/src/profile.ts";
import { scopeCovers } from "./user-memory.ts";

export const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60_000;
export const LEDGER_MAX = 200;
const SUPPORT_MAX = 24;
const SUPPORT_EVIDENCE_MAX = 4;

// A recall signal with where and when it was said.
export interface NightSignal {
  readonly signal: DreamSignal;
  readonly workerId: string;
  readonly chat: string;
  readonly project: string | null;
  // When the user said it (the earliest cited line).
  readonly at: number;
  // The user's cited lines.
  readonly evidence: readonly DreamEvidence[];
}

export interface MatchResult {
  readonly ledger: DreamCandidate[];
  readonly known: number;
  readonly declined: number;
  readonly invalid: number;
}

// ---- markers --------------------------------------------------------------------

// Lowercase, Turkish letters folded to ASCII — the user often types without them.
export function foldText(text: string): string {
  return text.toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

// The model's marker counts only if the user's own lines contain it.
export function groundedMarker(marker: string | null, userLines: readonly string[]): string | null {
  if (!marker?.trim()) return null;
  const m = foldText(marker).replace(/\s+/g, " ").trim();
  return userLines.some((l) => foldText(l).replace(/\s+/g, " ").includes(m)) ? marker.trim() : null;
}

const EVERY_PROJECT = /\b(every|all|any) (project|repo)s?\b|\beverywhere\b|\bher (proje|repo|yerde)|\b(tum|butun) (proje|repo)/;

// ---- support ----------------------------------------------------------------------

export function dayKey(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function supportOf(n: NightSignal): DreamSupport {
  return {
    workerId: n.workerId, chat: n.chat, project: n.project, day: dayKey(n.at), at: n.at,
    stance: n.signal.stance, marker: n.signal.marker, reason: n.signal.reason, irreversible: n.signal.irreversible,
    evidence: n.evidence.slice(0, SUPPORT_EVIDENCE_MAX),
  };
}

// Rereading a chat (a failed night retried) never counts the same lines twice.
function sameOccasionLines(a: DreamSupport, b: DreamSupport): boolean {
  if (a.workerId !== b.workerId) return false;
  const ids = new Set(a.evidence.map((e) => e.eventId));
  return b.evidence.some((e) => ids.has(e.eventId));
}

function withSupport(c: DreamCandidate, add: readonly DreamSupport[]): DreamCandidate {
  const fresh = add.filter((s) => !c.support.some((x) => sameOccasionLines(x, s)));
  if (!fresh.length) return c;
  const support = [...c.support, ...fresh].sort((a, b) => a.at - b.at).slice(-SUPPORT_MAX);
  return { ...c, support, firstSeen: Math.min(c.firstSeen, ...fresh.map((s) => s.at)), lastSeen: Math.max(c.lastSeen, ...fresh.map((s) => s.at)) };
}

export function summarizeSupport(c: DreamCandidate): DreamSupportSummary & { readonly irreversible: boolean } {
  const explicit = c.support.some((s) => s.marker !== null);
  return {
    chats: new Set(c.support.map((s) => s.workerId)).size,
    days: new Set(c.support.map((s) => s.day)).size,
    projects: new Set(c.support.map((s) => s.project).filter((p) => p !== null)).size,
    firstSeen: c.firstSeen,
    lastSeen: c.lastSeen,
    origin: explicit ? "explicit" : "inferred",
    irreversible: c.support.some((s) => s.irreversible),
  };
}

export function isCandidateReady(c: DreamCandidate): boolean {
  const s = summarizeSupport(c);
  return s.origin === "explicit" || s.irreversible || (s.chats >= 2 && s.days >= 2);
}

// Global once seen in two settings (two projects, or a project and a no-folder
// chat), or when the user said it holds everywhere; otherwise the one project.
export function candidateScope(c: DreamCandidate): UserMemoryScope {
  const settings = new Set(c.support.map((s) => s.project ?? ""));
  const everywhere = c.support.some((s) => s.marker !== null && EVERY_PROJECT.test(foldText(s.marker)));
  const only = [...settings][0];
  if (settings.size >= 2 || everywhere || !only) return { kind: "global" };
  return { kind: "project", path: only };
}

// Drops what nothing reinforced lately; keeps the ledger bounded.
export function decayLedger(ledger: readonly DreamCandidate[], now: number): DreamCandidate[] {
  return ledger
    .filter((c) => now - c.lastSeen < CANDIDATE_TTL_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, LEDGER_MAX);
}

// ---- matching -----------------------------------------------------------------------

// Files tonight's signals per the model's groups: support for an open candidate, a
// new candidate, or a memory that already says it (known / declined). A group that
// contradicts a kept memory, or shows a kept project memory in another setting,
// becomes a candidate aimed at that memory. Each signal counts once; a group that
// resolves to nothing is invalid.
export function applyMatches(
  ledger: readonly DreamCandidate[],
  night: readonly NightSignal[],
  groups: readonly DreamMatchGroup[],
  memories: readonly UserMemory[],
  newId: () => string,
): MatchResult {
  const next = new Map(ledger.map((c) => [c.id, c]));
  const used = new Set<number>();
  let known = 0;
  let declined = 0;
  let invalid = 0;

  const add = (claim: string | null, target: string | null, signals: readonly NightSignal[]): boolean => {
    const existing = target ? [...next.values()].find((c) => c.target === target) : undefined;
    if (existing) {
      next.set(existing.id, withSupport(existing, signals.map(supportOf)));
      return true;
    }
    if (!claim?.trim()) return false;
    const support = signals.map(supportOf).sort((a, b) => a.at - b.at);
    const c: DreamCandidate = {
      id: newId(),
      claim: claim.trim(),
      object: signals.every((s) => s.signal.object === "user-fact") ? "user-fact" : "agent-behaviour",
      target,
      support: [],
      firstSeen: support[0]!.at,
      lastSeen: support.at(-1)!.at,
    };
    next.set(c.id, withSupport({ ...c, support: [support[0]!] }, support.slice(1)));
    return true;
  };

  for (const g of groups) {
    const signals = g.signals.filter((i) => i < night.length && !used.has(i)).map((i) => night[i]!);
    if (!signals.length) { invalid++; continue; }
    for (const i of g.signals) used.add(i);
    const memory = g.memory ? memories.find((m) => m.id === g.memory) : undefined;
    if (memory?.status === "dismissed") { declined++; continue; }
    // A kept project memory showing up in another setting may hold everywhere.
    const elsewhere = memory?.status === "active" && signals.some((s) => !scopeCovers(memory.scope, s.project));
    if (memory && !(memory.status === "active" && (g.contradicts || elsewhere))) { known++; continue; }
    const candidate = g.candidate ? next.get(g.candidate) : undefined;
    if (candidate && !memory) {
      next.set(candidate.id, withSupport(candidate, signals.map(supportOf)));
      continue;
    }
    const claim = g.claim ?? (memory && !g.contradicts ? memory.text : null);
    if (!add(claim, memory?.id ?? null, signals)) invalid++;
  }
  return { ledger: [...next.values()], known, declined, invalid };
}
