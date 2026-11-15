import { describe, it, expect } from "vitest";
import { noteWorkerEvent, noteResync, getEventSignal, subscribe } from "./eventSignalStore.js";

describe("eventSignalStore", () => {
  it("counts every worker event, keeps the last worker, and counts state changes apart", () => {
    const start = getEventSignal();
    noteWorkerEvent("a", false);
    noteWorkerEvent("b", true);
    const s = getEventSignal();
    expect(s.tick).toBe(start.tick + 2);
    expect(s.workerId).toBe("b");
    expect(s.changeTick).toBe(start.changeTick + 1);
  });

  it("a resync bumps both counters with no worker", () => {
    noteWorkerEvent("a", false);
    const before = getEventSignal();
    noteResync();
    expect(getEventSignal()).toEqual({ tick: before.tick + 1, workerId: null, changeTick: before.changeTick + 1 });
  });

  it("each change is a new snapshot and notifies subscribers", () => {
    let calls = 0;
    const unsub = subscribe(() => { calls++; });
    const before = getEventSignal();
    noteWorkerEvent("a", false);
    expect(getEventSignal()).not.toBe(before);
    expect(calls).toBe(1);
    unsub();
    noteWorkerEvent("a", false);
    expect(calls).toBe(1);
  });
});
