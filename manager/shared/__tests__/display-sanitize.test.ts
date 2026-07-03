import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sanitizeForDisplay, sanitizeEventRowForDisplay } from "../display-sanitize.ts";
import { applySenderTag } from "../../../core/src/domain/sender-tag.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

// The wrapper a tagged runtime message / boot prompt carries, exactly as
// applySenderTag renders it — the shape stored in lifecycle:message_received or
// echoed by the model into its own output.
const wrapped = applySenderTag("do the thing", "agent", { from: "boss", "from-id": "o1" });

describe("sanitizeForDisplay — deep string sanitize on a copy", () => {
  it("strips wrappers in nested text-bearing fields without mutating the input", () => {
    const payload = {
      phase: "message_received",
      text: wrapped,
      nested: { input: { command: `echo ${wrapped}` } },
      list: [wrapped, "clean"],
    };
    const before = JSON.stringify(payload);
    const out = JSON.stringify(sanitizeForDisplay(payload));
    assert.ok(!out.includes("<agent_message"));
    assert.ok(!out.includes("<system_message"));
    assert.ok(out.includes("do the thing"));
    // original object untouched
    assert.equal(JSON.stringify(payload), before);
  });

  it("passes primitives and non-plain objects through untouched", () => {
    assert.equal(sanitizeForDisplay(42), 42);
    assert.equal(sanitizeForDisplay(true), true);
    assert.equal(sanitizeForDisplay(null), null);
    const d = new Date(0);
    assert.equal(sanitizeForDisplay(d), d); // same reference, not structurally copied
  });

  it("no-ops on clean payloads", () => {
    const clean = { phase: "prompt_sent", text: "hello world" };
    assert.deepEqual(sanitizeForDisplay(clean), clean);
  });
});

describe("sanitizeEventRowForDisplay — /events + get_worker row egress", () => {
  it("a tagged stored event yields no wrapper in the serialized row", () => {
    const row: WorkerEventRow = {
      id: 7,
      worker_id: "w-1",
      ts: 1000,
      type: "lifecycle",
      payload: JSON.stringify({ phase: "message_received", text: wrapped }),
    };
    const out = sanitizeEventRowForDisplay(row);
    assert.ok(!out.payload!.includes("<agent_message"));
    assert.ok(!out.payload!.includes("<system_message"));
    assert.ok(out.payload!.includes("do the thing"));
    // row identity preserved, stored row not mutated
    assert.equal(out.id, 7);
    assert.equal(out.type, "lifecycle");
    assert.ok(row.payload!.includes("<agent_message"));
  });

  it("a model-echoed wrapper inside a jsonl assistant_text is stripped", () => {
    const row: WorkerEventRow = {
      id: 8,
      worker_id: "w-1",
      ts: 1001,
      type: "jsonl",
      payload: JSON.stringify({ kind: "assistant_text", text: `here it is: ${wrapped}` }),
    };
    const out = sanitizeEventRowForDisplay(row);
    assert.ok(!out.payload!.includes("<agent_message"));
    assert.ok(out.payload!.includes("here it is: do the thing"));
  });

  it("fast-paths (returns same ref) and no-ops clean rows and null payloads", () => {
    const clean: WorkerEventRow = { id: 1, worker_id: "w", ts: 1, type: "state", payload: JSON.stringify({ state: "WORKING" }) };
    assert.equal(sanitizeEventRowForDisplay(clean), clean);
    const nullish: WorkerEventRow = { id: 2, worker_id: "w", ts: 2, type: "heartbeat", payload: null };
    assert.equal(sanitizeEventRowForDisplay(nullish), nullish);
  });
});
