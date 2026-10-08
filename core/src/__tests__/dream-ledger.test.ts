import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyMatches, CANDIDATE_TTL_MS, candidateScope, dayKey, decayLedger, groundedMarker, isCandidateReady, summarizeSupport,
  type NightSignal,
} from "../domain/dream-ledger.ts";
import type { DreamCandidate, DreamSignal } from "../../../contracts/src/dream.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";

const DAY = 24 * 60 * 60_000;
const T0 = new Date(2026, 9, 5, 12).getTime();

function night(i: number, over: { workerId?: string; project?: string | null; at?: number; signal?: Partial<DreamSignal> } = {}): NightSignal {
  const workerId = over.workerId ?? `w-${i}`;
  return {
    signal: { ask: `ask ${i}`, object: "agent-behaviour", stance: "process-correction", marker: null, reason: null, irreversible: false, evidence: [i], ...over.signal },
    workerId, chat: `chat ${workerId}`, project: over.project === undefined ? "/eos" : over.project, at: over.at ?? T0,
    evidence: [{ quote: `line ${i}`, workerId, chat: `chat ${workerId}`, eventId: i, by: "user" }],
  };
}

const mem = (id: string, status: UserMemory["status"], scope: UserMemory["scope"] = { kind: "global" }): UserMemory => ({
  id, text: `memory ${id}`, category: "work-style", scope, tier: "always", status, source: { kind: "user" }, rev: 0, createdAt: 0, updatedAt: 0,
});

const ids = (): (() => string) => { let n = 0; return () => `dc-${++n}`; };

function candidateFrom(signals: NightSignal[]): DreamCandidate {
  return applyMatches([], signals, [{ signals: signals.map((_, i) => i), candidate: null, memory: null, contradicts: false, claim: "c" }], [], ids()).ledger[0]!;
}

describe("dream ledger markers", () => {
  it("a marker counts only when the user's own lines contain it, Turkish letters or not", () => {
    assert.equal(groundedMarker("bundan sonra", ["Bundan sonra böyle yap"]), "bundan sonra");
    assert.equal(groundedMarker("şimdiden sonra hep", ["simdiden sonra hep boyle"]), "şimdiden sonra hep");
    assert.equal(groundedMarker("always", ["just do it this once"]), null);
    assert.equal(groundedMarker(null, ["always"]), null);
  });
});

describe("dream ledger matching", () => {
  it("one group → one candidate; the same chat on the same day is one occasion", () => {
    const r = applyMatches([], [night(1, { workerId: "w-a" }), night(2, { workerId: "w-a" })],
      [{ signals: [0, 1], candidate: null, memory: null, contradicts: false, claim: "Wants plans first." }], [], ids());
    assert.equal(r.ledger.length, 1);
    const s = summarizeSupport(r.ledger[0]!);
    assert.deepEqual([s.chats, s.days, s.origin], [1, 1, "inferred"]);
  });

  it("support for an open candidate accrues; rereading the same lines never counts twice", () => {
    const first = applyMatches([], [night(1)], [{ signals: [0], candidate: null, memory: null, contradicts: false, claim: "c" }], [], ids());
    const again = applyMatches(first.ledger, [night(1), night(2, { at: T0 + DAY })],
      [{ signals: [0, 1], candidate: "dc-1", memory: null, contradicts: false, claim: null }], [], ids());
    assert.equal(again.ledger[0]!.support.length, 2);
    assert.equal(again.ledger[0]!.lastSeen, T0 + DAY);
  });

  it("a memory that already says it: kept/pending → known, declined → declined", () => {
    const memories = [mem("um-k", "active"), mem("um-p", "suggested"), mem("um-d", "dismissed")];
    const r = applyMatches([], [night(1), night(2), night(3)], [
      { signals: [0], candidate: null, memory: "um-k", contradicts: false, claim: null },
      { signals: [1], candidate: null, memory: "um-p", contradicts: false, claim: null },
      { signals: [2], candidate: null, memory: "um-d", contradicts: false, claim: null },
    ], memories, ids());
    assert.deepEqual([r.ledger.length, r.known, r.declined], [0, 2, 1]);
  });

  it("contradicting a kept memory, or a project memory showing up elsewhere, aims a candidate at it", () => {
    const memories = [mem("um-k", "active"), mem("um-p", "active", { kind: "project", path: "/eos" })];
    const r = applyMatches([], [night(1), night(2, { project: "/game" })], [
      { signals: [0], candidate: null, memory: "um-k", contradicts: true, claim: "Now wants the opposite." },
      { signals: [1], candidate: null, memory: "um-p", contradicts: false, claim: null },
    ], memories, ids());
    assert.deepEqual(r.ledger.map((c) => [c.target, c.claim]), [["um-k", "Now wants the opposite."], ["um-p", "memory um-p"]]);
  });

  it("groups that resolve to nothing are invalid; a signal counts once", () => {
    const r = applyMatches([], [night(1)], [
      { signals: [0], candidate: null, memory: null, contradicts: false, claim: "c" },
      { signals: [0], candidate: null, memory: null, contradicts: false, claim: "again" },
      { signals: [7], candidate: null, memory: null, contradicts: false, claim: "out of range" },
    ], [], ids());
    assert.equal(r.ledger.length, 1);
    assert.equal(r.invalid, 2);
  });
});

describe("dream ledger readiness and scope", () => {
  it("ready when stated as a rule, guarding an irreversible action, or seen in ≥ 2 chats on ≥ 2 days", () => {
    assert.ok(isCandidateReady(candidateFrom([night(1, { signal: { marker: "from now on" } })])));
    assert.ok(isCandidateReady(candidateFrom([night(1, { signal: { irreversible: true } })])));
    assert.ok(!isCandidateReady(candidateFrom([night(1), night(2)]))); // two chats, one day
    assert.ok(!isCandidateReady(candidateFrom([night(1, { workerId: "w-a" }), night(2, { workerId: "w-a", at: T0 + DAY })]))); // one chat, two days
    assert.ok(isCandidateReady(candidateFrom([night(1), night(2, { at: T0 + DAY })])));
  });

  it("global once seen in two settings or said to hold everywhere; else its one project", () => {
    assert.deepEqual(candidateScope(candidateFrom([night(1), night(2)])), { kind: "project", path: "/eos" });
    assert.deepEqual(candidateScope(candidateFrom([night(1), night(2, { project: "/game" })])), { kind: "global" });
    assert.deepEqual(candidateScope(candidateFrom([night(1), night(2, { project: null })])), { kind: "global" });
    assert.deepEqual(candidateScope(candidateFrom([night(1, { project: null })])), { kind: "global" });
    assert.deepEqual(candidateScope(candidateFrom([night(1, { signal: { marker: "her projede" } })])), { kind: "global" });
  });

  it("candidates nothing reinforced lately fade", () => {
    const c = candidateFrom([night(1)]);
    assert.equal(decayLedger([c], T0 + CANDIDATE_TTL_MS - 1).length, 1);
    assert.equal(decayLedger([c], T0 + CANDIDATE_TTL_MS).length, 0);
    assert.equal(dayKey(T0), "2026-10-05");
  });
});
