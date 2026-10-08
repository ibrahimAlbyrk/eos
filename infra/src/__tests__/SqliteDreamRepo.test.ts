import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteDreamRepo } from "../persistence/SqliteDreamRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { DreamCandidate, DreamRun } from "../../../contracts/src/dream.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

const run = (id: string, startedAt: number, over: Partial<DreamRun> = {}): DreamRun => ({
  id, trigger: "nightly", status: "done", reason: null, startedAt, finishedAt: startedAt + 1, model: "opus",
  chatsRead: 2, observations: 3, proposed: 1, tokens: 900, narrative: "You asked for depth.",
  dropped: { oneOff: 1, known: 0, declined: 0, secret: 0, weak: 1, invalid: 0, product: 2, taskBound: 1, choice: 0, critic: 1, style: 0, capped: 0 },
  chats: [{ workerId: "w-1", name: "profile-design", project: "/eos", userTurns: 4, observations: 2 }],
  candidates: 0, rejected: [],
  ...over,
});

const candidate = (id: string, lastSeen: number): DreamCandidate => ({
  id, claim: "Wants a plan before large features.", object: "agent-behaviour", target: null, firstSeen: lastSeen, lastSeen,
  support: [{
    workerId: "w-1", chat: "profile-design", project: "/eos", day: "2026-10-05", at: lastSeen, stance: "general-rule",
    marker: "bundan sonra", reason: null, irreversible: false,
    evidence: [{ quote: "bundan sonra önce plan", workerId: "w-1", chat: "profile-design", eventId: 11, by: "user" }],
  }],
});

let repo: SqliteDreamRepo;
beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteDreamRepo(db);
});

describe("SqliteDreamRepo", () => {
  it("saves, upserts and lists runs newest first", () => {
    repo.save(run("dr-a", 100, { status: "running", finishedAt: null }));
    repo.save(run("dr-b", 200));
    repo.save(run("dr-a", 100)); // the finished row replaces the running one
    assert.deepEqual(repo.list(10).map((r) => r.id), ["dr-b", "dr-a"]);
    assert.equal(repo.get("dr-a")?.status, "done");
    assert.equal(repo.latest()?.id, "dr-b");
    assert.equal(repo.get("dr-none"), null);
  });

  it("watermarks default to 0 and move forward", () => {
    assert.equal(repo.watermark("w-1"), 0);
    repo.setWatermark("w-1", 42);
    repo.setWatermark("w-1", 77);
    assert.equal(repo.watermark("w-1"), 77);
  });

  it("exclusions toggle", () => {
    repo.setExcluded("w-1", true);
    repo.setExcluded("w-1", true);
    repo.setExcluded("w-2", true);
    repo.setExcluded("w-2", false);
    assert.deepEqual(repo.excluded(), ["w-1"]);
  });

  it("the candidate ledger is replaced as a whole and listed most recent first", () => {
    assert.deepEqual(repo.candidates(), []);
    repo.replaceCandidates([candidate("dc-a", 100), candidate("dc-b", 200)]);
    assert.deepEqual(repo.candidates().map((c) => c.id), ["dc-b", "dc-a"]);
    repo.replaceCandidates([candidate("dc-c", 300)]);
    assert.deepEqual(repo.candidates().map((c) => c.id), ["dc-c"]);
    assert.equal(repo.candidates()[0]!.support[0]!.marker, "bundan sonra");
  });
});
