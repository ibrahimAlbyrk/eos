import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UsageService } from "../UsageService.ts";
import type { SubscriptionUsageProvider } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
import type { ProviderUsage } from "../../../contracts/src/usage.ts";

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const snapshot = (): ProviderUsage => ({
  provider: "claude",
  windows: { fiveHour: { utilization: 41, resetsAt: "2026-07-17T22:50:00Z" } },
  fetchedAt: "2026-07-17T20:00:00Z",
});

describe("UsageService", () => {
  it("serves the cached value within the min-interval floor, refetches after it", async () => {
    let calls = 0;
    const clock = fakeClock(1000);
    const provider: SubscriptionUsageProvider = {
      id: "claude",
      async fetchUsage() { calls++; return snapshot(); },
    };
    const svc = new UsageService({ providers: [provider], clock, minIntervalMs: 180_000 });

    await svc.getUsage();
    await svc.getUsage();
    assert.equal(calls, 1); // second call served from cache

    clock.advance(179_999);
    await svc.getUsage();
    assert.equal(calls, 1); // still inside the floor

    clock.advance(1); // floor now elapsed exactly
    await svc.getUsage();
    assert.equal(calls, 2); // refetched upstream
  });

  it("collapses concurrent refreshes onto a single upstream call", async () => {
    let calls = 0;
    const clock = fakeClock(0);
    const provider: SubscriptionUsageProvider = {
      id: "claude",
      async fetchUsage() { calls++; await Promise.resolve(); return snapshot(); },
    };
    const svc = new UsageService({ providers: [provider], clock });
    await Promise.all([svc.getUsage(), svc.getUsage(), svc.getUsage()]);
    assert.equal(calls, 1);
  });

  it("surfaces a provider error in errors[] without failing the response", async () => {
    const clock = fakeClock(0);
    const bad: SubscriptionUsageProvider = {
      id: "claude",
      async fetchUsage() { throw new Error("OAuth token does not meet scope requirement"); },
    };
    const svc = new UsageService({ providers: [bad], clock });
    const res = await svc.getUsage();
    assert.equal(res.providers.length, 0);
    assert.deepEqual(res.errors, [
      { provider: "claude", reason: "OAuth token does not meet scope requirement" },
    ]);
  });

  it("keeps a healthy provider even when another fails", async () => {
    const clock = fakeClock(0);
    const ok: SubscriptionUsageProvider = { id: "claude", async fetchUsage() { return snapshot(); } };
    const bad: SubscriptionUsageProvider = { id: "other", async fetchUsage() { throw new Error("down"); } };
    const svc = new UsageService({ providers: [ok, bad], clock });
    const res = await svc.getUsage();
    assert.equal(res.providers.length, 1);
    assert.equal(res.providers[0].provider, "claude");
    assert.deepEqual(res.errors, [{ provider: "other", reason: "down" }]);
  });
});
