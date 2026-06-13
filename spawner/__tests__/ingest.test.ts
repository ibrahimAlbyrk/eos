import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRecord } from "../ingest.ts";

// parseRecord is a hand-written per-`as` parser (NOT schema-driven), so every
// MessageRecord variant needs an explicit case here — a missing one silently
// drops the record and the worker never emits that chat event.
describe("parseRecord", () => {
  it("drops null / unknown variants", () => {
    assert.equal(parseRecord(null), undefined);
    assert.equal(parseRecord("x"), undefined);
    assert.equal(parseRecord({ as: "nope" }), undefined);
  });

  it("parses the existing variants", () => {
    assert.deepEqual(parseRecord({ as: "user_message", displayText: "hi" }), { as: "user_message", displayText: "hi" });
    assert.deepEqual(
      parseRecord({ as: "orchestrator_message", fromParent: "o1", parentName: "orch" }),
      { as: "orchestrator_message", fromParent: "o1", parentName: "orch" },
    );
    assert.deepEqual(
      parseRecord({ as: "worker_report", fromWorker: "w1", workerName: "wk", displayText: "done" }),
      { as: "worker_report", fromWorker: "w1", workerName: "wk", displayText: "done" },
    );
  });

  it("parses a peer_request record (regression: missing case dropped the chat event)", () => {
    assert.deepEqual(
      parseRecord({ as: "peer_request", fromWorker: "w-frank", fromName: "peer-frank", displayText: "what's the API?", sentAt: 5 }),
      { as: "peer_request", fromWorker: "w-frank", fromName: "peer-frank", displayText: "what's the API?", sentAt: 5 },
    );
    assert.equal(parseRecord({ as: "peer_request", displayText: "x" }), undefined); // fromWorker required
  });
});
