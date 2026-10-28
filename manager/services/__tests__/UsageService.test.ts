import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UsageService } from "../UsageService.ts";
import { NoUsageAccountError, type SubscriptionUsageProvider } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
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

  // A provider whose fetches succeed until `fail` is set, then throw `fail()`.
  function flaky() {
    let calls = 0;
    let fail: (() => Error) | null = null;
    const provider: SubscriptionUsageProvider = {
      id: "claude",
      async fetchUsage() { calls++; if (fail) throw fail(); return snapshot(); },
    };
    return { provider, calls: () => calls, failWith: (f: (() => Error) | null) => { fail = f; } };
  }

  it("keeps serving the last good snapshot, marked stale, when a fetch fails", async () => {
    const clock = fakeClock(0);
    const p = flaky();
    const svc = new UsageService({ providers: [p.provider], clock, minIntervalMs: 1000 });
    await svc.getUsage();
    p.failWith(() => new Error("usage fetch failed (HTTP 429)"));
    clock.advance(1000);
    const res = await svc.getUsage();
    assert.deepEqual(res.providers, [{ ...snapshot(), stale: true }]);
    assert.deepEqual(res.errors, [{ provider: "claude", reason: "usage fetch failed (HTTP 429)" }]);

    p.failWith(null);
    clock.advance(1000);
    assert.deepEqual((await svc.getUsage()).providers, [snapshot()]);
  });

  it("backs off a failing provider while its stale snapshot covers the gap", async () => {
    const clock = fakeClock(0);
    const p = flaky();
    const svc = new UsageService({ providers: [p.provider], clock, minIntervalMs: 1000 });
    await svc.getUsage();
    p.failWith(() => new Error("down"));
    clock.advance(1000);
    await svc.getUsage(); // failure 1 → retry after 1 s
    clock.advance(1000);
    await svc.getUsage(); // failure 2 → retry after 2 s
    assert.equal(p.calls(), 3);
    clock.advance(1000);
    const res = await svc.getUsage();
    assert.equal(p.calls(), 3); // still backing off
    assert.equal(res.providers[0].stale, true);
    clock.advance(1000);
    await svc.getUsage();
    assert.equal(p.calls(), 4);
  });

  it("drops the snapshot once the account is signed out", async () => {
    const clock = fakeClock(0);
    const p = flaky();
    const svc = new UsageService({ providers: [p.provider], clock, minIntervalMs: 1000 });
    await svc.getUsage();
    p.failWith(() => new NoUsageAccountError("not signed in"));
    clock.advance(1000);
    const res = await svc.getUsage();
    assert.deepEqual(res.providers, []);
    assert.deepEqual(res.errors, [{ provider: "claude", reason: "not signed in" }]);
  });

  it("serves a saved snapshot after a restart when the first fetch fails", async () => {
    let saved: ProviderUsage[] = [];
    const store = { load: () => saved, save: (s: ProviderUsage[]) => { saved = s; } };
    await new UsageService({ providers: [flaky().provider], clock: fakeClock(0), store }).getUsage();
    assert.deepEqual(saved, [snapshot()]);

    const p = flaky();
    p.failWith(() => new Error("down"));
    const res = await new UsageService({ providers: [p.provider], clock: fakeClock(0), store }).getUsage();
    assert.deepEqual(res.providers, [{ ...snapshot(), stale: true }]);
  });
});

describe("UsageService — a provider list read live, one snapshot per sign-in", () => {
  const snap = (loginId: string, used: number) => ({
    provider: "claude", loginId, label: loginId, windows: { fiveHour: { utilization: used, resetsAt: null } }, fetchedAt: "t",
  });
  const provider = (loginId: string, used: number) => ({ id: `claude:${loginId}`, fetchUsage: async () => snap(loginId, used) });

  it("serves each sign-in's snapshot, picks up a new one and drops a removed one", async () => {
    let list = [provider("a", 10)];
    let now = 0;
    const svc = new UsageService({ providers: () => list, clock: { now: () => now }, minIntervalMs: 1 });
    assert.deepEqual((await svc.getUsage()).providers.map((p) => p.loginId), ["a"]);
    list = [provider("a", 10), provider("b", 60)];
    now = 10;
    assert.deepEqual((await svc.getUsage()).providers.map((p) => p.loginId), ["a", "b"]);
    assert.deepEqual(svc.peek().map((p) => p.windows.fiveHour?.utilization), [10, 60]);
    list = [provider("b", 60)];
    assert.deepEqual(svc.peek().map((p) => p.loginId), ["b"]);
  });

  it("a saved snapshot comes back under its sign-in", () => {
    const svc = new UsageService({
      providers: () => [provider("a", 0)],
      clock: { now: () => 0 },
      store: { load: () => [snap("a", 42)], save: () => {} },
    });
    assert.equal(svc.peek()[0].windows.fiveHour?.utilization, 42);
  });
});
