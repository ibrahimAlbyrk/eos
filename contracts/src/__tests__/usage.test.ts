import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UsageWindowSchema,
  ProviderUsageSchema,
  UsageResponseSchema,
} from "../usage.ts";

describe("usage schemas", () => {
  it("accepts a full Claude provider snapshot", () => {
    const snapshot = {
      provider: "claude",
      plan: "Max",
      windows: {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 59, resetsAt: "2026-07-21T06:00:00Z", severity: "normal" },
        weeklyByModel: [{ model: "Fable", utilization: 12, resetsAt: "2026-07-21T06:00:00Z", severity: "normal" }],
      },
      extraUsage: { isEnabled: false, usedCredits: 0, monthlyLimit: null, currency: "USD" },
      fetchedAt: "2026-07-17T20:09:00Z",
    };
    const parsed = ProviderUsageSchema.parse(snapshot);
    assert.equal(parsed.windows.fiveHour?.resetsAt, null);
    assert.equal(parsed.windows.sevenDay?.severity, "normal");
    assert.equal(parsed.windows.weeklyByModel?.[0].model, "Fable");
    assert.equal(parsed.extraUsage?.currency, "USD");
  });

  it("allows windows to be omitted entirely (minimal snapshot)", () => {
    const parsed = ProviderUsageSchema.parse({
      provider: "claude",
      windows: {},
      fetchedAt: "2026-07-17T20:09:00Z",
    });
    assert.equal(parsed.plan, undefined);
    assert.equal(parsed.extraUsage, undefined);
  });

  it("requires utilization and resetsAt (null when not started) on a window", () => {
    assert.throws(() => UsageWindowSchema.parse({ utilization: 10 }));
    assert.throws(() => UsageWindowSchema.parse({ resetsAt: "2026-07-17T20:09:00Z" }));
  });

  it("carries provider errors alongside an empty providers list", () => {
    const parsed = UsageResponseSchema.parse({
      providers: [],
      errors: [{ provider: "claude", reason: "OAuth token does not meet scope requirement" }],
    });
    assert.equal(parsed.providers.length, 0);
    assert.equal(parsed.errors?.[0].provider, "claude");
  });

  it("errors is optional on a clean response", () => {
    const parsed = UsageResponseSchema.parse({ providers: [] });
    assert.equal(parsed.errors, undefined);
  });
});
