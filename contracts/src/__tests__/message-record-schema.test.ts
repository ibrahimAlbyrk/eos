import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageRecordSchema } from "../http.ts";

describe("MessageRecordSchema report_reminder", () => {
  it("accepts a report_reminder record with displayText + sentAt", () => {
    const r = MessageRecordSchema.safeParse({ as: "report_reminder", displayText: "report now", sentAt: 123 });
    assert.ok(r.success);
    assert.equal(r.success && r.data.as, "report_reminder");
  });

  it("accepts a bare report_reminder record (both optionals absent)", () => {
    assert.ok(MessageRecordSchema.safeParse({ as: "report_reminder" }).success);
  });

  it("rejects an unknown as discriminator", () => {
    assert.ok(!MessageRecordSchema.safeParse({ as: "report_nudge" }).success);
  });
});

describe("MessageRecordSchema permission_ask", () => {
  it("accepts a permission_ask record with displayText + sentAt", () => {
    const r = MessageRecordSchema.safeParse({ as: "permission_ask", displayText: "worker asking", sentAt: 7 });
    assert.ok(r.success);
    assert.equal(r.success && r.data.as, "permission_ask");
  });

  it("accepts a bare permission_ask record (both optionals absent)", () => {
    assert.ok(MessageRecordSchema.safeParse({ as: "permission_ask" }).success);
  });
});
