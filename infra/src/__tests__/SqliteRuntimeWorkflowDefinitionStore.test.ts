import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteRuntimeWorkflowDefinitionStore } from "../persistence/SqliteRuntimeWorkflowDefinitionStore.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import { WorkflowGraphSchema } from "../../../contracts/src/workflow-graph.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

function def(name: string, prompt = "do it"): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    name,
    description: `${name} desc`,
    root: { type: "step", id: "s1", prompt },
  });
}

function openMigrated(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  runMigrations(db, noopLog as never);
  return db;
}

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rwfd-test-"));
  dbFile = join(dir, "state.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteRuntimeWorkflowDefinitionStore", () => {
  it("survives a restart — a second adapter over the same db file sees the first's rows", () => {
    const db1 = openMigrated(dbFile);
    new SqliteRuntimeWorkflowDefinitionStore(db1).create("orch-1", def("review"));
    db1.close();

    const db2 = openMigrated(dbFile);
    const recs = new SqliteRuntimeWorkflowDefinitionStore(db2).listFor("orch-1");
    db2.close();

    assert.equal(recs.length, 1);
    assert.equal(recs[0].name, "review");
    assert.equal(recs[0].source, "runtime");
    assert.deepEqual(recs[0].root, { type: "step", id: "s1", prompt: "do it" });
  });

  it("create is an UPSERT — same (owner,name) overwrites instead of duplicating", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("review", "v1"));
    store.create("orch-1", def("review", "v2"));
    const recs = store.listFor("orch-1");
    db.close();

    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0].root, { type: "step", id: "s1", prompt: "v2" });
  });

  it("round-trips a v2 node graph (the editor SAVE path), not only v1 trees", () => {
    const graph = WorkflowGraphSchema.parse({
      name: "g2", version: 2,
      nodes: [
        { id: "in", kind: "input" },
        { id: "out", kind: "output" },
      ],
      edges: [{ from: { node: "in" }, to: { node: "out" } }],
    });
    const db1 = openMigrated(dbFile);
    new SqliteRuntimeWorkflowDefinitionStore(db1).create("orch-1", graph);
    db1.close();

    const db2 = openMigrated(dbFile);
    const recs = new SqliteRuntimeWorkflowDefinitionStore(db2).listFor("orch-1");
    db2.close();

    assert.equal(recs.length, 1);
    assert.equal(recs[0].name, "g2");
    assert.equal(recs[0].source, "runtime");
    assert.equal((recs[0] as { version?: number }).version, 2);
    assert.ok(Array.isArray((recs[0] as { nodes?: unknown[] }).nodes), "the v2 graph survived the round-trip");
  });

  it("isolates definitions per owner — one orchestrator never sees another's", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("a"));
    store.create("orch-1", def("b"));
    store.create("orch-2", def("c"));

    assert.deepEqual(store.listFor("orch-1").map((r) => r.name).sort(), ["a", "b"]);
    assert.deepEqual(store.listFor("orch-2").map((r) => r.name), ["c"]);
    assert.deepEqual(store.listFor("orch-none"), []);
    db.close();
  });

  it("skips an invalid/garbage json row instead of crashing listFor", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("good"));
    const insert = db.prepare(
      "INSERT INTO workflow_definitions (owner, name, json, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
    );
    insert.run("orch-1", "broken", "not json{");
    insert.run("orch-1", "wrongshape", JSON.stringify({ description: "no name or root" }));

    const recs = store.listFor("orch-1");
    db.close();
    assert.deepEqual(recs.map((r) => r.name), ["good"]);
  });

  it("delete removes one (owner,name) row and reports whether it existed", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("keep"));
    store.create("orch-1", def("drop"));

    assert.equal(store.delete("orch-1", "drop"), true, "deleting an existing row returns true");
    assert.deepEqual(store.listFor("orch-1").map((r) => r.name), ["keep"], "only the named row is gone");
    assert.equal(store.delete("orch-1", "drop"), false, "deleting an already-gone row returns false");
    assert.equal(store.delete("orch-1", "never"), false, "deleting an unknown name returns false");
    db.close();
  });

  it("delete is owner-scoped — one owner's delete never touches another's same-named def", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("shared"));
    store.create("orch-2", def("shared"));

    assert.equal(store.delete("orch-1", "shared"), true);
    assert.deepEqual(store.listFor("orch-1"), []);
    assert.deepEqual(store.listFor("orch-2").map((r) => r.name), ["shared"], "the other owner's def survives");
    db.close();
  });

  it("deleteForOwner drops only that owner's definitions", () => {
    const db = openMigrated(dbFile);
    const store = new SqliteRuntimeWorkflowDefinitionStore(db);
    store.create("orch-1", def("a"));
    store.create("orch-2", def("b"));
    store.deleteForOwner("orch-1");

    assert.deepEqual(store.listFor("orch-1"), []);
    assert.deepEqual(store.listFor("orch-2").map((r) => r.name), ["b"]);
    db.close();
  });
});
