import { describe, it, expect, vi, afterEach } from "vitest";
import { applyProgress, checkFor, clearCheck, pruneExcept, reconcile, subscribe } from "./loopCheckStore.js";

// Module-level state — unique worker ids per assertion to avoid bleed.
let n = 0;
const wid = () => `lc${n++}`;
const prog = (workerId, phase, extra = {}) => ({ workerId, attempt: 2, maxAttempts: 5, strategy: "hybrid", phase, ...extra });

afterEach(() => { vi.useRealTimers(); });

describe("loopCheckStore", () => {
  it("ignores a payload with no workerId", () => {
    applyProgress({ phase: "started", attempt: 1 });
    // nothing keyed — a fresh worker is still empty
    expect(checkFor(wid())).toBeNull();
  });

  it("holds the latest progress phase per worker", () => {
    const w = wid();
    applyProgress(prog(w, "started"));
    applyProgress(prog(w, "verifying", { criterionId: "c1" }));
    const c = checkFor(w);
    expect(c).toMatchObject({ phase: "verifying", criterionId: "c1", attempt: 2, maxAttempts: 5 });
  });

  it("stamps a startedAt that persists across phases of the same check", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const w = wid();
    applyProgress(prog(w, "started"));
    const started = checkFor(w).startedAt;
    vi.setSystemTime(4000);
    applyProgress(prog(w, "judging"));
    expect(checkFor(w).startedAt).toBe(started); // continuous elapsed clock
  });

  it("a new 'started' resets the elapsed clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const w = wid();
    applyProgress(prog(w, "started"));
    vi.setSystemTime(9000);
    applyProgress(prog(w, "started")); // a brand-new check
    expect(checkFor(w).startedAt).toBe(9000);
  });

  it("lingers on 'verdict' then auto-clears after the linger window", () => {
    vi.useFakeTimers();
    const w = wid();
    applyProgress(prog(w, "verdict", { met: false, outcome: "continued", reason: "unmet: c1" }));
    expect(checkFor(w)).toMatchObject({ phase: "verdict", outcome: "continued" });
    vi.advanceTimersByTime(2000);
    expect(checkFor(w)).toBeNull();
  });

  it("a fresh phase cancels a pending verdict-linger clear", () => {
    vi.useFakeTimers();
    const w = wid();
    applyProgress(prog(w, "verdict", { met: false, outcome: "continued" }));
    applyProgress(prog(w, "started")); // a new check began — keep it
    vi.advanceTimersByTime(2000);
    expect(checkFor(w)).toMatchObject({ phase: "started" });
  });

  it("clearCheck removes an entry immediately; pruneExcept drops absent workers", () => {
    const keep = wid();
    const gone = wid();
    applyProgress(prog(keep, "verifying"));
    applyProgress(prog(gone, "verifying"));
    clearCheck(gone);
    expect(checkFor(gone)).toBeNull();
    expect(checkFor(keep)).toBeTruthy();
    const other = wid();
    applyProgress(prog(other, "judging"));
    pruneExcept(new Set([keep]));
    expect(checkFor(other)).toBeNull();
    expect(checkFor(keep)).toBeTruthy();
  });

  it("reconcile clears a pending check when its worker is no longer IDLE", () => {
    const w = wid();
    applyProgress(prog(w, "verifying"));
    reconcile([{ id: w, state: "WORKING" }]); // re-triggered before the verdict landed
    expect(checkFor(w)).toBeNull();
  });

  it("reconcile keeps a check while its worker is still IDLE (check genuinely running)", () => {
    const w = wid();
    applyProgress(prog(w, "verifying"));
    reconcile([{ id: w, state: "IDLE" }]);
    expect(checkFor(w)).toBeTruthy();
  });

  it("reconcile leaves a verdict entry to its linger timer even if the worker moved on", () => {
    vi.useFakeTimers();
    const w = wid();
    applyProgress(prog(w, "verdict", { met: false, outcome: "continued" }));
    reconcile([{ id: w, state: "WORKING" }]);
    expect(checkFor(w)).toMatchObject({ phase: "verdict" }); // still visible
    vi.advanceTimersByTime(2000);
    expect(checkFor(w)).toBeNull(); // linger owns the cleanup
  });

  it("reconcile drops checks for workers absent from the live list", () => {
    const keep = wid();
    const gone = wid();
    applyProgress(prog(keep, "verifying"));
    applyProgress(prog(gone, "verifying"));
    reconcile([{ id: keep, state: "IDLE" }]);
    expect(checkFor(gone)).toBeNull();
    expect(checkFor(keep)).toBeTruthy();
  });

  it("notifies subscribers on change", () => {
    const w = wid();
    const cb = vi.fn();
    const unsub = subscribe(cb);
    applyProgress(prog(w, "started"));
    expect(cb).toHaveBeenCalled();
    unsub();
  });
});
