// User memory rules — pure. Which memories a session may see (scope), when two
// memories say the same thing (so a suggestion never piles up a duplicate), and
// keyword search for the on-demand tier.

import type { UserMemory, UserMemoryProposal, UserMemoryScope } from "../../../contracts/src/profile.ts";

export const DUPLICATE_SIMILARITY = 0.8;

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// A project memory covers its folder and everything below it.
export function scopeCovers(scope: UserMemoryScope, project: string | null): boolean {
  if (scope.kind === "global") return true;
  if (!project) return false;
  return project === scope.path || project.startsWith(`${scope.path.replace(/\/+$/, "")}/`);
}

// Kept memories a session in `project` may see.
export function memoriesInScope(memories: readonly UserMemory[], project: string | null): UserMemory[] {
  return memories.filter((m) => m.status === "active" && scopeCovers(m.scope, project));
}

// Token-set Jaccard: order- and punctuation-insensitive, cheap, good enough to catch
// the same preference phrased twice.
export function memorySimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

// An existing memory (kept or pending) that already says `text` for this scope. A
// global memory covers any project, so it also counts against a project suggestion.
export function findDuplicateMemory(
  text: string, scope: UserMemoryScope, pool: readonly UserMemory[],
): UserMemory | null {
  let best: UserMemory | null = null;
  let bestScore = 0;
  for (const m of pool) {
    if (m.scope.kind !== "global" && scopeKey(m.scope) !== scopeKey(scope)) continue;
    const score = memorySimilarity(text, m.text);
    if (score >= DUPLICATE_SIMILARITY && score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

// A change-proposal (update/merge/promote/retire) already pending or declined for the
// same targets — or an update that wouldn't change its target's text.
export function findDuplicateProposal(
  text: string, proposal: UserMemoryProposal, pool: readonly UserMemory[],
): UserMemory | null {
  const key = [...proposal.targets].sort().join(",");
  const same = pool.find((m) => m.status !== "active" && m.proposal?.kind === proposal.kind
    && [...m.proposal.targets].sort().join(",") === key
    && (proposal.kind === "retire" || memorySimilarity(text, m.text) >= DUPLICATE_SIMILARITY));
  if (same) return same;
  if (proposal.kind === "update") {
    const target = pool.find((m) => m.id === proposal.targets[0]);
    if (target && memorySimilarity(text, target.text) >= DUPLICATE_SIMILARITY) return target;
  }
  return null;
}

// Kept memories in scope ranked by how many query words they contain; an empty query
// lists the newest first.
export function searchMemories(
  memories: readonly UserMemory[], query: string, project: string | null, limit: number,
): UserMemory[] {
  const pool = memoriesInScope(memories, project);
  const q = words(query);
  if (!q.size) return [...pool].sort(newestFirst).slice(0, limit);
  return pool
    .map((m) => ({ m, score: matchScore(q, m.text) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || newestFirst(a.m, b.m))
    .slice(0, limit)
    .map((r) => r.m);
}

export function scopeKey(scope: UserMemoryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.path}`;
}

export function newestFirst(a: UserMemory, b: UserMemory): number {
  return b.updatedAt - a.updatedAt;
}

function matchScore(query: ReadonlySet<string>, text: string): number {
  const w = words(text);
  let hits = 0;
  for (const q of query) if (w.has(q) || [...w].some((x) => x.startsWith(q))) hits++;
  return hits / query.size;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
}
