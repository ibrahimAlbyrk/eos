import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteDreamRepo } from "../persistence/SqliteDreamRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { DreamRun } from "../../../contracts/src/dream.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

const run = (id: string, startedAt: number, over: Partial<DreamRun> = {}): DreamRun => ({
  id, trigger: "nightly", status: "done", reason: null, startedAt, finishedAt: startedAt + 1, model: "opus",
  chatsRead: 2, observations: 3, proposed: 1, tokens: 900, narrative: "You asked for depth.",
  dropped: { oneOff: 1, known: 0, declined: 0, secret: 0, weak: 1, invalid: 0 },
  chats: [{ workerId: "w-1", name: "profile-design", project: "/eos", userTurns: 4, observations: 2 }],
  ...over,
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
});
