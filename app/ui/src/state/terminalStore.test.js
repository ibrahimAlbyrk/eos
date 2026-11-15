import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startRun, liveRunsFor, purge, pruneExcept, applyChunk, applyDone, clearWorkspaceRuns, removeRun, subscribe } from "./terminalStore.js";

// Module-level state — keep worker ids unique per assertion to avoid bleed.
let n = 0;
const wid = () => `w${n++}`;

// applyChunk arms the store's coalescing flush timer (node has no
// requestAnimationFrame). Fake timers for the whole file so no real timer keeps
// the flush latch set across tests.
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("terminalStore purge/pruneExcept", () => {
  it("purge drops a worker's runs and leaves others", () => {
    const a = wid();
    const b = wid();
    startRun(a, `r-${a}`, "ls");
    startRun(b, `r-${b}`, "ls");
    purge(a);
    expect(liveRunsFor(a)).toHaveLength(0);
    expect(liveRunsFor(b)).toHaveLength(1);
  });

  it("pruneExcept drops absent workers but keeps present ones and workspace runs", () => {
    const keep = wid();
    const gone = wid();
    startRun(keep, `r-${keep}`, "ls");
    startRun(gone, `r-${gone}`, "ls");
    startRun(null, "r-workspace", "ls"); // workspace run — no owning worker
    pruneExcept(new Set([keep]));
    expect(liveRunsFor(keep)).toHaveLength(1);
    expect(liveRunsFor(gone)).toHaveLength(0);
    expect(liveRunsFor(null)).toHaveLength(1); // workspace run untouched
  });
});

describe("terminalStore cleared-set bounding", () => {
  it("suppresses late chunks of a dismissed run, then forgets it on done", () => {
    const runId = `r-clear-${n++}`;
    startRun(null, runId, "ls"); // workspace run
    clearWorkspaceRuns(); // dismiss → runId enters `cleared`
    applyChunk({ workerId: null, runId, data: "late" }); // suppressed, no re-materialize
    expect(liveRunsFor(null)).toHaveLength(0);
    // done lands → runId leaves `cleared`, so a reused id is no longer suppressed
    applyDone({ runId });
    applyChunk({ workerId: null, runId, data: "again" });
    expect(liveRunsFor(null)).toHaveLength(1);
  });
});

describe("terminalStore notifications", () => {
  const collect = () => {
    const calls = [];
    const unsub = subscribe((workerId) => calls.push(workerId));
    return { calls, unsub };
  };

  it("coalesces output chunks into one notification per worker per flush", () => {
    const a = wid();
    const b = wid();
    startRun(a, `r-${a}`, "yes");
    startRun(b, `r-${b}`, "yes");
    const { calls, unsub } = collect();
    applyChunk({ workerId: a, runId: `r-${a}`, data: "1" });
    applyChunk({ workerId: a, runId: `r-${a}`, data: "2" });
    applyChunk({ workerId: b, runId: `r-${b}`, data: "x" });
    expect(liveRunsFor(a)[0].output).toBe("12"); // readable before the flush
    expect(calls).toEqual([]);
    vi.runAllTimers();
    expect(calls).toEqual([a, b]);
    unsub();
  });

  it("notifies start, done, remove and dismissal at once, with the run's worker", () => {
    const a = wid();
    const { calls, unsub } = collect();
    startRun(a, `r-${a}`, "ls");
    expect(calls).toEqual([a]);
    applyDone({ runId: `r-${a}`, exitCode: 0 });
    expect(calls).toEqual([a, a]);
    removeRun(`r-${a}`);
    expect(calls).toEqual([a, a, a]);
    removeRun(`r-${a}`); // already gone: no notification
    expect(calls).toEqual([a, a, a]);
    startRun(null, `r-ws-${a}`, "ls");
    clearWorkspaceRuns();
    expect(calls).toEqual([a, a, a, null, null]);
    unsub();
  });

  it("an immediate notification covers chunks still waiting for the flush", () => {
    const a = wid();
    startRun(a, `r-${a}`, "ls");
    const { calls, unsub } = collect();
    applyChunk({ workerId: a, runId: `r-${a}`, data: "out" });
    applyDone({ runId: `r-${a}`, exitCode: 1 });
    expect(calls).toEqual([a]);
    vi.runAllTimers();
    expect(calls).toEqual([a]);
    unsub();
  });
});
