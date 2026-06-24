import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkflowStepRepo } from "../persistence/SqliteWorkflowStepRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { WorkflowStep } from "../../../contracts/src/workflow.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

// Canonical parsed-DTO shape: an absent `output` is the key omitted, not
// present-with-undefined — that's what the adapter returns.
function step(runId: string, nodeId: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  const row: WorkflowStep = {
    id: `${runId}:${nodeId}`,
    runId,
    nodeId,
    nodeType: "step",
    status: "running",
    workerId: `w-${nodeId}`,
    startedAt: 1000,
    endedAt: null,
    ...over,
  };
  if (row.output === undefined) delete row.output;
  return row;
}

let db: DatabaseSync;
let repo: SqliteWorkflowStepRepo;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteWorkflowStepRepo(db);
});

describe("migration 053_workflow_steps", () => {
  it("applies cleanly and creates the workflow_steps table + run index", () => {
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_steps'")
      .get() as { name: string } | undefined;
    assert.equal(tbl?.name, "workflow_steps");
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_steps_run'")
      .get() as { name: string } | undefined;
    assert.equal(idx?.name, "idx_workflow_steps_run");
  });
});

describe("SqliteWorkflowStepRepo journal", () => {
  it("upsert → findByNode returns an equal DTO (every field round-trips)", () => {
    const s = step("r-1", "n-1", { status: "passed", output: { verdict: "real" }, endedAt: 2000 });
    repo.upsert(s);
    assert.deepEqual(repo.findByNode("r-1", "n-1"), s);
  });

  it("findByNode returns the journaled step by composite PK; null when absent", () => {
    repo.upsert(step("r-1", "n-1"));
    assert.equal(repo.findByNode("r-1", "n-1")?.id, "r-1:n-1");
    assert.equal(repo.findByNode("r-1", "missing"), null);
    assert.equal(repo.findByNode("other-run", "n-1"), null);
  });

  it("upsert overwrites status/output on the same node but preserves the original started_at", () => {
    repo.upsert(step("r-1", "n-1", { status: "running", startedAt: 100 }));
    repo.upsert(step("r-1", "n-1", { status: "passed", output: { ok: true }, startedAt: 999, endedAt: 200 }));

    const found = repo.findByNode("r-1", "n-1");
    assert.ok(found);
    assert.equal(found.status, "passed");
    assert.deepEqual(found.output, { ok: true });
    assert.equal(found.startedAt, 100); // original start survives re-upsert
    assert.equal(found.endedAt, 200);
  });

  it("listByRun scopes to one run, ordered by started_at", () => {
    repo.upsert(step("r-1", "a", { startedAt: 1 }));
    repo.upsert(step("r-1", "b", { startedAt: 2 }));
    repo.upsert(step("r-2", "c", { startedAt: 3 }));

    assert.deepEqual(repo.listByRun("r-1").map((x) => x.nodeId), ["a", "b"]);
    assert.deepEqual(repo.listByRun("r-2").map((x) => x.nodeId), ["c"]);
    assert.deepEqual(repo.listByRun("none"), []);
  });

  it("setStatus and setOutput mutate the addressed step (the crash-correctness path)", () => {
    repo.upsert(step("r-1", "n-1", { status: "running", output: undefined }));
    repo.setOutput("r-1", "n-1", { confirmed: true });
    repo.setStatus("r-1", "n-1", "passed");

    const found = repo.findByNode("r-1", "n-1");
    assert.equal(found?.status, "passed");
    assert.deepEqual(found?.output, { confirmed: true });
  });

  it("setWorker stamps the worker id onto a running row (the recovery key, §3.7)", () => {
    repo.upsert(step("r-1", "n-1", { status: "running", workerId: null }));
    repo.setWorker("r-1", "n-1", "w-42");
    const found = repo.findByNode("r-1", "n-1");
    assert.equal(found?.workerId, "w-42");
    assert.equal(found?.status, "running"); // status untouched
  });

  it("round-trips a null workerId and an absent output", () => {
    const s = step("r-1", "n-1", { workerId: null, output: undefined });
    repo.upsert(s);
    const found = repo.findByNode("r-1", "n-1");
    assert.ok(found);
    assert.equal(found.workerId, null);
    assert.equal(found.output, undefined);
    assert.deepEqual(found, s);
  });

  it("skips a row with corrupt output_json instead of throwing", () => {
    repo.upsert(step("r-1", "good", { startedAt: 1 }));
    db.prepare(
      `INSERT INTO workflow_steps (id, run_id, node_id, node_type, status, worker_id, output_json, started_at, ended_at)
       VALUES ('r-1:broken', 'r-1', 'broken', 'step', 'passed', NULL, ?, 2, NULL)`,
    ).run("not json{");

    assert.deepEqual(repo.listByRun("r-1").map((x) => x.nodeId), ["good"]);
    assert.equal(repo.findByNode("r-1", "broken"), null);
  });
});
