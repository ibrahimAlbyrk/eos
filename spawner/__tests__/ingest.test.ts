import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRecord, parseWorkerInput } from "../ingest.ts";

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

// Characterization tests pinning the exact per-path behavior before/after the
// switch to a typed WorkerInput union: strict 500 on malformed JSON for the
// daemon-owned paths, tolerant empty-body for the hook paths, 400 on a missing
// required field, no-body paths always parse.
describe("parseWorkerInput", () => {
  const q = (s = ""): URLSearchParams => new URLSearchParams(s);

  it("/message: valid → typed message with the parsed record", () => {
    assert.deepEqual(
      parseWorkerInput("/message", q(), JSON.stringify({ text: "hi", record: { as: "user_message" } })),
      { ok: true, input: { kind: "message", text: "hi", record: { as: "user_message" } } },
    );
  });

  it("/message: missing text → 400, malformed JSON → 500 (strict)", () => {
    assert.deepEqual(parseWorkerInput("/message", q(), JSON.stringify({})), { ok: false, status: 400, error: "text required" });
    const bad = parseWorkerInput("/message", q(), "{not json");
    assert.equal(bad.ok, false);
    assert.equal(bad.ok === false && bad.status, 500);
  });

  it("/keystroke: valid → typed keystroke; missing keys → 400", () => {
    assert.deepEqual(parseWorkerInput("/keystroke", q(), JSON.stringify({ keys: "\x1b" })), { ok: true, input: { kind: "keystroke", keys: "\x1b" } });
    assert.deepEqual(parseWorkerInput("/keystroke", q(), JSON.stringify({})), { ok: false, status: 400, error: "keys required" });
  });

  it("/interrupt and /rewind-targets carry no body", () => {
    assert.deepEqual(parseWorkerInput("/interrupt", q(), ""), { ok: true, input: { kind: "interrupt" } });
    assert.deepEqual(parseWorkerInput("/rewind-targets", q(), ""), { ok: true, input: { kind: "rewindTargets" } });
  });

  it("/rewind tolerates malformed JSON (empty body) and passes uuid/mode through", () => {
    assert.deepEqual(parseWorkerInput("/rewind", q(), "garbage"), { ok: true, input: { kind: "rewind", body: {} } });
    assert.deepEqual(
      parseWorkerInput("/rewind", q(), JSON.stringify({ uuid: "u", mode: "m" })),
      { ok: true, input: { kind: "rewind", body: { uuid: "u", mode: "m" } } },
    );
  });

  it("default → hook with the event name from the query; tolerates malformed JSON", () => {
    assert.deepEqual(parseWorkerInput("/event", q("event=Stop"), "nope"), { ok: true, input: { kind: "hook", eventName: "Stop", body: {} } });
    assert.deepEqual(parseWorkerInput("/anything", q(), JSON.stringify({ a: 1 })), { ok: true, input: { kind: "hook", eventName: "Unknown", body: { a: 1 } } });
  });
});
