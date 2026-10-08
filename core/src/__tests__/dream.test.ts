import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  applyVerdicts, checkProposals, filterSignals, isAwayDue, isNightlyDue, lintMemoryText, looksSecret, nextNightly,
  nightlySlot, parseConsolidation, parseCritic, parseMatch, parseRecall, renderChatForDream, scrubSecrets,
} from "../domain/dream.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";
import type { DreamCandidate, DreamProposalDraft, DreamSignal } from "../../../contracts/src/dream.ts";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).getTime();

describe("dream schedule", () => {
  it("the slot is tonight's HH:MM once passed, else last night's", () => {
    assert.equal(nightlySlot(at(2026, 9, 4, 3, 30), "03:00"), at(2026, 9, 4, 3));
    assert.equal(nightlySlot(at(2026, 9, 4, 2, 0), "03:00"), at(2026, 9, 3, 3));
    assert.equal(nextNightly(at(2026, 9, 4, 3, 30), "03:00"), at(2026, 9, 5, 3));
  });

  it("due once per slot; a Mac asleep at 03:00 dreams when it wakes", () => {
    const enabledAt = at(2026, 9, 3, 15);
    assert.ok(!isNightlyDue(at(2026, 9, 3, 20), "03:00", enabledAt)); // enabled this afternoon
    assert.ok(isNightlyDue(at(2026, 9, 4, 8), "03:00", enabledAt)); // woke at 08:00
    assert.ok(!isNightlyDue(at(2026, 9, 4, 9), "03:00", at(2026, 9, 4, 8))); // already ran
  });

  it("away: idle long enough, nothing working, once per stretch", () => {
    const now = at(2026, 9, 4, 12);
    const lastUser = now - 25 * 60_000;
    assert.ok(isAwayDue(now, 20, lastUser, false, 0));
    assert.ok(!isAwayDue(now, 20, lastUser, true, 0));
    assert.ok(!isAwayDue(now, 30, lastUser, false, 0));
    assert.ok(!isAwayDue(now, 20, lastUser, false, lastUser + 1));
  });
});

describe("dream rendering", () => {
  it("tags lines with event ids, keeps the user's words, trims the agent's, drops other roles", () => {
    const r = renderChatForDream([
      { id: 1, role: "user", text: "bu konu üzerinde detaylıca düşün", at: 1 },
      { id: 2, role: "assistant", text: "x".repeat(900), at: 2 },
      { id: 3, role: "worker", text: "report", at: 3 },
      { id: 4, role: "user", text: "my key is sk-ant-abcdefghijklmnopqrstuvwx", at: 4 },
    ]);
    assert.match(r.text, /^\[e1\] USER: bu konu/);
    assert.match(r.text, /\[e2\] AGENT: x{600}…/);
    assert.doesNotMatch(r.text, /report/);
    assert.match(r.text, /\[e4\] USER: my key is \[redacted\]/);
    assert.equal(r.userTurns, 2);
    assert.equal(r.lines.get(4)?.text, "my key is [redacted]");
    assert.equal(r.lines.get(4)?.at, 4);
  });

  it("over budget, the oldest lines go first", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ id: i, role: "user" as const, text: `line ${i} ${"pad ".repeat(20)}`, at: i }));
    const r = renderChatForDream(msgs, 1000);
    assert.ok(r.text.length <= 1100);
    assert.ok(r.lines.has(49) && !r.lines.has(0));
  });

  it("secrets are recognised and scrubbed", () => {
    for (const s of ["ghp_abcdefghijklmnopqrstuvwxyz12", "AKIAABCDEFGHIJKLMNOP", "password = hunter2hunter2", "-----BEGIN RSA PRIVATE KEY-----\nabc"]) {
      assert.ok(looksSecret(s), s);
      assert.match(scrubSecrets(s), /\[redacted\]/);
    }
    assert.ok(!looksSecret("Prefers pnpm over npm."));
  });
});

describe("dream model output", () => {
  it("checks each structured answer against its schema; anything else is nothing", () => {
    assert.deepEqual(parseRecall("garbage"), []);
    assert.equal(parseRecall({ signals: [{ ask: "Wants depth.", object: "agent-behaviour", stance: "general-rule", evidence: [1] }] }).length, 1);
    assert.equal(parseMatch({ groups: "nope" }), null);
    assert.equal(parseConsolidation({ proposals: "nope" }), null);
    assert.deepEqual(parseConsolidation({ proposals: [] })?.setAside, []);
    assert.equal(parseCritic({ verdicts: [{ proposal: 0 }] }), null);
  });
});

describe("which signals can become memories", () => {
  const sig = (object: DreamSignal["object"], stance: DreamSignal["stance"]): DreamSignal =>
    ({ ask: "x", object, stance, marker: null, reason: null, irreversible: false, evidence: [1] });

  it("drops the product, one task's steps and accepted options; keeps how to work with the user", () => {
    const f = filterSignals([
      sig("artifact", "general-rule"), sig("project-convention", "general-rule"), sig("agent-behaviour", "product-feedback"),
      sig("agent-behaviour", "task-instruction"), sig("agent-behaviour", "choice"),
      sig("agent-behaviour", "general-rule"), sig("agent-behaviour", "process-correction"), sig("user-fact", "general-rule"),
    ]);
    assert.deepEqual([f.product, f.taskBound, f.choice, f.kept.length], [3, 1, 1, 3]);
  });
});

describe("memory writing rules", () => {
  it("a rule opens with its situation, a fact with 'The user'; no hedges, no shouting, ≤ 40 words", () => {
    assert.equal(lintMemoryText("When fixing a bug, find the root cause before changing code."), null);
    assert.equal(lintMemoryText("Before posting on GitHub, show the draft and wait for approval."), null);
    assert.equal(lintMemoryText("The user builds games in Unity."), null);
    assert.match(lintMemoryText("Prefers minimal, airy UI.")!, /situation/);
    assert.match(lintMemoryText("When committing, usually split the changes.")!, /usually/);
    assert.match(lintMemoryText("When committing, NEVER push.")!, /capitals/);
    assert.match(lintMemoryText(`When x, ${"word ".repeat(45)}`)!, /40 words/);
  });
});

describe("dream proposals", () => {
  const mem = (id: string, scope: UserMemory["scope"] = { kind: "global" }, status: UserMemory["status"] = "active"): UserMemory => ({
    id, text: id, category: "work-style", scope, tier: "always", status, source: { kind: "user" }, rev: 0, createdAt: 0, updatedAt: 0,
  });
  const cand = (id: string, projects: (string | null)[]): DreamCandidate => ({
    id, claim: "c", object: "agent-behaviour", target: null, firstSeen: 1, lastSeen: 2,
    support: projects.map((project, i) => ({
      workerId: `w-${i}`, chat: "c", project, day: `2026-10-0${i + 1}`, at: i, stance: "general-rule", marker: null, reason: null,
      irreversible: false, evidence: [{ quote: "q", workerId: `w-${i}`, chat: "c", eventId: i, by: "user" }],
    })),
  });
  const draft = (over: Partial<DreamProposalDraft>): DreamProposalDraft => ({
    candidate: "dc-g", kind: "new", text: "When planning, ask first.", category: "work-style", domain: "planning",
    targets: [], why: "Agents act too early.", ...over,
  });

  it("checks the candidate, targets, writing and scope of each kind", () => {
    const memories = [mem("um-a"), mem("um-b"), mem("um-p", { kind: "project", path: "/eos" }), mem("um-x", { kind: "global" }, "dismissed")];
    const ready = [cand("dc-g", ["/eos", "/game"]), cand("dc-p", ["/eos"])];
    const r = checkProposals([
      draft({}),
      draft({ candidate: "dc-p" }),
      draft({ candidate: "dc-gone" }),
      draft({ kind: "update", targets: ["um-a"] }),
      draft({ kind: "update", targets: ["um-x"] }), // tombstone isn't kept
      draft({ kind: "merge", targets: ["um-a", "um-b"] }),
      draft({ kind: "promote", targets: ["um-p"] }),
      draft({ kind: "promote", targets: ["um-a"] }), // already global
      draft({ kind: "retire", targets: ["um-p"], text: "No longer true." }), // a retire's text is a reason
      draft({ text: "When asked, token: abcdefghijkl" }),
      draft({ text: "Usually wants plans." }),
    ], memories, ready);
    assert.equal(r.accepted.length, 6);
    assert.deepEqual([r.invalid, r.secret, r.style], [3, 1, 1]);
    assert.match(r.rejected[0]!.reason, /^Writing:/);
    assert.deepEqual(r.accepted[0]!.scope, { kind: "global" }); // seen in two projects
    assert.deepEqual(r.accepted[1]!.scope, { kind: "project", path: "/eos" });
    assert.deepEqual(r.accepted.find((a) => a.draft.kind === "promote")?.scope, { kind: "global" });
    assert.deepEqual(r.accepted.find((a) => a.draft.kind === "retire")?.scope, { kind: "project", path: "/eos" });
  });

  it("the critic must vouch: keep + a quote that says it; no verdict refutes", () => {
    const { accepted } = checkProposals([
      draft({}), draft({ text: "When reviewing, group feedback." }), draft({ text: "When testing, mute audio." }),
    ], [], [cand("dc-g", ["/eos"])]);
    const out = applyVerdicts(accepted, [
      { proposal: 0, keep: true, fails: [], quotes: [{ eventId: 1, says: "yes" }], reason: "" },
      { proposal: 1, keep: true, fails: [], quotes: [{ eventId: 1, says: "topical" }], reason: "" },
    ]);
    assert.deepEqual(out.kept.map((p) => p.draft.text), ["When planning, ask first."]);
    assert.deepEqual(out.rejected.map((r) => r.reason), ["No cited line actually says it", "The critic gave no verdict"]);
    const refuted = applyVerdicts(accepted.slice(0, 1), [{ proposal: 0, keep: false, fails: [2], quotes: [], reason: "A step of one test cycle." }]);
    assert.equal(refuted.rejected[0]!.reason, "A step of one test cycle. (one task's step)");
  });
});
