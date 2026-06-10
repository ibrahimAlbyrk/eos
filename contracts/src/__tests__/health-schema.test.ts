import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { HealthResponseSchema } from "../http.ts";

describe("HealthResponseSchema", () => {
  it("accepts a stamped health body", () => {
    const r = HealthResponseSchema.safeParse({
      ok: true,
      pid: 1234,
      startedAt: 1_750_000_000_000,
      sourceStamp: "a".repeat(64),
    });
    assert.equal(r.success, true);
  });

  it("rejects the legacy {ok:true}-only body (treated as unstamped)", () => {
    assert.equal(HealthResponseSchema.safeParse({ ok: true }).success, false);
  });
});
