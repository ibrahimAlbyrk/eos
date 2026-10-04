import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkProposals, isAwayDue, isNightlyDue, looksSecret, nextNightly, nightlySlot,
  parseConsolidation, parseRecall, renderChatForDream, scrubSecrets,
} from "../domain/dream.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";
import type { DreamProposalDraft } from "../../../contracts/src/dream.ts";

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
      { id: 1, role: "user", text: "bu konu üzerinde detaylıca düşün" },
      { id: 2, role: "assistant", text: "x".repeat(900) },
      { id: 3, role: "worker", text: "report" },
      { id: 4, role: "user", text: "my key is sk-ant-abcdefghijklmnopqrstuvwx" },
    ]);
    assert.match(r.text, /^\[e1\] USER: bu konu/);
    assert.match(r.text, /\[e2\] AGENT: x{600}…/);
    assert.doesNotMatch(r.text, /report/);
    assert.match(r.text, /\[e4\] USER: my key is \[redacted\]/);
    assert.equal(r.userTurns, 2);
    assert.equal(r.lines.get(4)?.text, "my key is [redacted]");
  });

  it("over budget, the oldest lines go first", () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ id: i, role: "user" as const, text: `line ${i} ${"pad ".repeat(20)}` }));
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
  it("checks the structured answer against its schema; anything else is nothing", () => {
    assert.deepEqual(parseRecall("garbage"), []);
    assert.equal(parseConsolidation({ proposals: "nope" }), null);
    assert.equal(parseRecall({ observations: [{ statement: "Wants depth.", kind: "preference", scope: "global", evidence: [1] }] }).length, 1);
    assert.deepEqual(parseConsolidation({ proposals: [] })?.dropped, {});
  });

  const mem = (id: string, scope: UserMemory["scope"] = { kind: "global" }, status: UserMemory["status"] = "active"): UserMemory => ({
    id, text: id, category: "work-style", scope, tier: "always", status, source: { kind: "user" }, rev: 0, createdAt: 0, updatedAt: 0,
  });
  const draft = (over: Partial<DreamProposalDraft>): DreamProposalDraft => ({
    kind: "new", text: "Wants depth.", category: "work-style", scope: "global", project: null, targets: [], confidence: 3, evidence: [], ...over,
  });

  it("checks each kind's targets and scope", () => {
    const memories = [mem("um-a"), mem("um-b"), mem("um-p", { kind: "project", path: "/eos" }), mem("um-x", { kind: "global" }, "dismissed")];
    const r = checkProposals([
      draft({}),
      draft({ scope: "project", project: "/eos" }),
      draft({ scope: "project", project: "/never-read" }),
      draft({ kind: "update", targets: ["um-a"] }),
      draft({ kind: "update", targets: ["um-x"] }), // tombstone isn't kept
      draft({ kind: "merge", targets: ["um-a", "um-b"] }),
      draft({ kind: "merge", targets: ["um-a"] }),
      draft({ kind: "promote", targets: ["um-p"] }),
      draft({ kind: "promote", targets: ["um-a"] }), // already global
      draft({ kind: "retire", targets: ["um-p"] }),
      draft({ text: "token: abcdefghijkl" }),
    ], memories, ["/eos"]);
    assert.equal(r.accepted.length, 6);
    assert.equal(r.invalid, 4);
    assert.equal(r.secret, 1);
    assert.deepEqual(r.accepted.find((a) => a.draft.kind === "promote")?.scope, { kind: "global" });
    assert.deepEqual(r.accepted.find((a) => a.draft.kind === "retire")?.scope, { kind: "project", path: "/eos" });
  });
});
