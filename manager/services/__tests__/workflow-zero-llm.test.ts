import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WorkflowService } from "../WorkflowService.ts";
import type { WorkflowServiceDeps } from "../WorkflowService.ts";
import { FileWorkflowDefinitionSource } from "../../../infra/src/workflow/FileWorkflowDefinitionSource.ts";
import { definitionOfRecord } from "../../../contracts/src/workflow-graph.ts";
import { buildEngine, spawnPort } from "../../../core/src/__tests__/helpers/workflowFakes.ts";

// HEADLINE acceptance (design A0/A6): a HUMAN-authored v2 node graph runs end to end
// with NO orchestrator, NO LLM, and ZERO worker spawns. The graph is a deterministic
// glue-only chain (input → transform → output): a `transform` node applies the
// registered pure `length` fn to the run args, so the run completes with no agent at
// all. We drive it through the OPERATOR-owned path (WorkflowService.run with the
// synthetic `operator` owner, exactly as the owner-less HTTP POST / CLI does) and
// assert the engine produced the right output with zero spawns.

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

const graphDoc = {
  name: "count-items",
  version: 2,
  nodes: [
    { id: "in", kind: "input" },
    { id: "len", kind: "transform", config: { fn: "length", over: "{{args.items}}" } },
    { id: "out", kind: "output" },
  ],
  edges: [
    { from: { node: "in" }, to: { node: "len" } },
    { from: { node: "len" }, to: { node: "out" } },
  ],
};

describe("zero-LLM run — a file-authored v2 graph runs through the operator-owned path with no agents", () => {
  it("loads the graph from disk and completes it with ZERO worker/expert spawns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-zero-llm-"));
    try {
      writeFileSync(join(dir, "count-items.json"), JSON.stringify(graphDoc), "utf8");

      // 1) Load + validate the file-authored graph (no daemon, no LLM).
      const records = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list();
      assert.equal(records.length, 1);
      const loaded = records[0];
      assert.equal((loaded as { version?: number }).version, 2, "loaded as a v2 graph");
      const def = definitionOfRecord(loaded);

      // 2) Real engine + real built-in executors; a programmable spawn port that
      //    records every spawn so we can assert none happened.
      const spawn = spawnPort();
      const { engine, deps: engineDeps } = buildEngine(spawn);

      // 3) Drive it through the operator-owned service path.
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => { resolveDone = r; });
      const delivered: Array<{ ownerId: string; result: { status: string; output: unknown } }> = [];

      const deps: WorkflowServiceDeps = {
        engine,
        runs: engineDeps.runs,
        spawn,
        progress: engineDeps.progress,
        definitions: { create() {}, listFor: () => [], deleteForOwner() {} },
        resolveDefinition: (name) => (name === "count-items" ? def : null),
        resolveMode: () => "acceptEdits",
        deliverCompletion: (ownerId, result) => { delivered.push({ ownerId, result }); resolveDone(); },
        ids: engineDeps.ids,
        log: noopLog,
      };
      const svc = new WorkflowService(deps);

      const started = svc.run({ from: "count-items", args: { items: ["a", "b", "c"] } }, "operator");
      assert.equal(started.status, "running");
      await done;

      // 4) The headline assertions: deterministic output, zero agents.
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].ownerId, "operator", "operator-owned run");
      assert.equal(delivered[0].result.status, "passed");
      assert.equal(delivered[0].result.output, 3, "transform(length) over a 3-item list");
      assert.equal(spawn.calls.steps.length, 0, "ZERO worker-node spawns");
      assert.equal(spawn.calls.experts.length, 0, "ZERO expert spawns");

      // and the run row settled passed with the same output.
      const row = engineDeps.runs.findById(started.runId)!;
      assert.equal(row.status, "passed");
      assert.equal(row.result, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
