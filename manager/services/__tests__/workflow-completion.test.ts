import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowCompletion, makeWorkflowCompletionDelivery } from "../workflow-completion.ts";
import type { WorkflowRunResult } from "../../../core/src/ports/WorkflowEngine.ts";

describe("renderWorkflowCompletion", () => {
  // The runId + status now ride as <system_message kind="worker_report" …> tag
  // attributes (applied at the dispatch chokepoint), so the body is the clean
  // serialized output — no inline "[workflow …] completed" header.
  it("is the clean serialized output (no inline header)", () => {
    const body = renderWorkflowCompletion({ runId: "run-1", status: "passed", output: { a: 1, b: "x" } });
    assert.equal(body, '{"a":1,"b":"x"}');
  });

  it("serializes a raw-string output verbatim", () => {
    const body = renderWorkflowCompletion({ runId: "run-2", status: "failed", output: "raw text" });
    assert.equal(body, '"raw text"');
  });
});

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const result = (runId: string): WorkflowRunResult => ({ runId, status: "passed", output: "ok" });

describe("makeWorkflowCompletionDelivery — agent vs operator owner (A6.4)", () => {
  it("delivers to the inbox when the owner is a live agent", () => {
    const delivered: Array<{ ownerId: string; result: WorkflowRunResult }> = [];
    const deliver = makeWorkflowCompletionDelivery({
      isAgentOwner: (ownerId) => ownerId === "orch-1",
      deliverToInbox: (ownerId, r) => delivered.push({ ownerId, result: r }),
      log: noopLog,
    });
    deliver("orch-1", result("run-1"));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].ownerId, "orch-1");
    assert.equal(delivered[0].result.runId, "run-1");
  });

  it("SKIPS the inbox for an operator-owned run (owner is not a live agent)", () => {
    const delivered: Array<{ ownerId: string; result: WorkflowRunResult }> = [];
    const deliver = makeWorkflowCompletionDelivery({
      isAgentOwner: () => false, // operator owner: no agent row stands behind it
      deliverToInbox: (ownerId, r) => delivered.push({ ownerId, result: r }),
      log: noopLog,
    });
    deliver("operator", result("run-2"));
    assert.equal(delivered.length, 0, "no agent inbox dispatch for an operator-owned run");
  });
});
