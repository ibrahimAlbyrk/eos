import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageRecalledPayloadSchema, WorkerEventTypeSchema } from "../events.ts";

describe("MessageRecalledPayloadSchema", () => {
  it("round-trips a full payload (text + clientMsgId + recalledRowId)", () => {
    const payload = { text: "draft to restore", clientMsgId: "c-123", recalledRowId: 42 };
    const r = MessageRecalledPayloadSchema.safeParse(payload);
    assert.ok(r.success);
    assert.deepEqual(r.data, payload);
  });

  it("accepts a keyless send (no clientMsgId) addressed only by rowId", () => {
    const r = MessageRecalledPayloadSchema.safeParse({ text: "hi", recalledRowId: 7 });
    assert.ok(r.success);
    assert.equal(r.data.clientMsgId, undefined);
  });

  it("requires text", () => {
    assert.ok(!MessageRecalledPayloadSchema.safeParse({ clientMsgId: "c" }).success);
  });

  it("message_recalled is a registered worker event type", () => {
    assert.ok(WorkerEventTypeSchema.safeParse("message_recalled").success);
  });
});
