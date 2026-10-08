import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DreamConsolidateOutputSchema, DreamCriticOutputSchema, DreamMatchOutputSchema, DreamRecallOutputSchema, DreamRunSchema,
} from "../dream.ts";

describe("dream contracts", () => {
  it("recall output: signals with event-id evidence; defaults fill", () => {
    const r = DreamRecallOutputSchema.parse({
      signals: [{ ask: "Mute browsers opened for game tests.", object: "agent-behaviour", stance: "general-rule", evidence: [12, 40] }],
    });
    assert.deepEqual([r.signals[0]!.marker, r.signals[0]!.reason, r.signals[0]!.irreversible], [null, null, false]);
    assert.ok(!DreamRecallOutputSchema.safeParse({ signals: [{ ask: "x", object: "agent-behaviour", stance: "general-rule", evidence: [] }] }).success);
    assert.ok(!DreamRecallOutputSchema.safeParse({ signals: [{ ask: "x", object: "trait", stance: "general-rule", evidence: [1] }] }).success);
  });

  it("match output: groups default to a new candidate", () => {
    const r = DreamMatchOutputSchema.parse({ groups: [{ signals: [0, 2], claim: "Wants plans before big changes." }] });
    assert.deepEqual(r.groups[0], { signals: [0, 2], candidate: null, memory: null, contradicts: false, claim: "Wants plans before big changes." });
  });

  it("consolidate output: at most three proposals, no 'other' category, unknown kinds fail", () => {
    const p = { candidate: "dc-1", kind: "new", text: "When committing, review the diff first.", category: "work-style", domain: "git", why: "Agents commit everything at once." };
    const r = DreamConsolidateOutputSchema.parse({ proposals: [p] });
    assert.equal(r.narrative, "");
    assert.deepEqual(r.proposals[0]!.targets, []);
    assert.deepEqual(r.setAside, []);
    assert.ok(!DreamConsolidateOutputSchema.safeParse({ proposals: [p, p, p, p] }).success);
    assert.ok(!DreamConsolidateOutputSchema.safeParse({ proposals: [{ ...p, category: "other" }] }).success);
    assert.ok(!DreamConsolidateOutputSchema.safeParse({ proposals: [{ ...p, kind: "rename" }] }).success);
  });

  it("critic output: verdicts with quote checks", () => {
    const r = DreamCriticOutputSchema.parse({ verdicts: [{ proposal: 0, keep: false, fails: [2], quotes: [{ eventId: 3, says: "topical" }] }] });
    assert.equal(r.verdicts[0]!.reason, "");
    assert.ok(!DreamCriticOutputSchema.safeParse({ verdicts: [{ proposal: 0, keep: true, fails: [6] }] }).success);
  });

  it("a run stored before the ledger still loads", () => {
    const r = DreamRunSchema.parse({
      id: "dr-1", trigger: "nightly", status: "done", reason: null, startedAt: 1, finishedAt: 2, model: "opus",
      chatsRead: 1, observations: 2, proposed: 0, tokens: 10, narrative: null,
      dropped: { oneOff: 1, known: 0, declined: 0, secret: 0, weak: 0, invalid: 0 }, chats: [],
    });
    assert.equal(r.candidates, 0);
    assert.deepEqual(r.rejected, []);
    assert.equal(r.dropped.product, 0);
  });
});
