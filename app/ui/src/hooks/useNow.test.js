import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A fresh module per test: the clock is module-wide.
let clock;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  vi.resetModules();
  clock = await import("./useNow.js");
});
afterEach(() => vi.useRealTimers());

describe("the shared clock", () => {
  it("ticks every reader once a second on one interval, and stops with the last reader", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = clock.subscribeClock(a);
    const offB = clock.subscribeClock(b);
    expect(vi.getTimerCount()).toBe(1);
    const t0 = clock.getNow();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(clock.getNow()).toBe(t0 + 1000);
    offA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("with no reader the time catches up in whole ticks and holds within one", () => {
    const t0 = clock.getNow();
    vi.advanceTimersByTime(400);
    expect(clock.getNow()).toBe(t0);
    vi.advanceTimersByTime(5000);
    const t1 = clock.getNow();
    expect(t1).toBe(Date.now());
    expect(clock.getNow()).toBe(t1);
  });

  it("a first reader starts from the current time", () => {
    vi.advanceTimersByTime(60_000);
    clock.subscribeClock(() => {});
    expect(clock.getNow()).toBe(Date.now());
  });
});
