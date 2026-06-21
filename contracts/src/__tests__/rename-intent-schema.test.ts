import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RenameIntentRequestSchema, ROUTES } from "../http.ts";

describe("RenameIntentRequestSchema", () => {
  it("accepts { active: boolean }", () => {
    assert.equal(RenameIntentRequestSchema.parse({ active: true }).active, true);
    assert.equal(RenameIntentRequestSchema.parse({ active: false }).active, false);
  });

  it("rejects a missing or non-boolean active", () => {
    assert.equal(RenameIntentRequestSchema.safeParse({}).success, false);
    assert.equal(RenameIntentRequestSchema.safeParse({ active: "yes" }).success, false);
  });

  it("ROUTES.workerRenameIntent builds the path", () => {
    assert.equal(ROUTES.workerRenameIntent("w1"), "/workers/w1/rename-intent");
  });
});
