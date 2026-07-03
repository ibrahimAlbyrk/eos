import { describe, it, expect, beforeEach } from "vitest";
import {
  getToasts, subscribe, push, beginExit, dismiss, clear, _resetToasts,
} from "./toastStore.js";

beforeEach(() => _resetToasts());

describe("toastStore", () => {
  it("push appends a toast, defaults severity/duration, and returns a monotonic id", () => {
    const id1 = push({ message: "hello" });
    const id2 = push({ severity: "error", message: "boom", duration: 6000 });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    const [a, b] = getToasts();
    expect(a).toMatchObject({ id: 1, severity: "info", message: "hello", duration: 3000, leaving: false });
    expect(b).toMatchObject({ id: 2, severity: "error", message: "boom", duration: 6000 });
  });

  it("getToasts returns a stable reference between non-mutating reads (useSyncExternalStore contract)", () => {
    push({ message: "x" });
    expect(getToasts()).toBe(getToasts());
  });

  it("notifies subscribers on each mutation and stops after unsubscribe", () => {
    let calls = 0;
    const off = subscribe(() => { calls += 1; });
    push({ message: "a" });
    push({ message: "b" });
    expect(calls).toBe(2);
    off();
    push({ message: "c" });
    expect(calls).toBe(2);
  });

  it("caps the stack at 4, evicting the oldest", () => {
    for (let i = 0; i < 6; i += 1) push({ message: `m${i}` });
    const list = getToasts();
    expect(list).toHaveLength(4);
    expect(list.map((t) => t.message)).toEqual(["m2", "m3", "m4", "m5"]); // m0/m1 evicted
  });

  it("beginExit flips only the matching toast to leaving and is idempotent (no re-emit)", () => {
    push({ message: "a" });
    push({ message: "b" });
    let calls = 0;
    subscribe(() => { calls += 1; });
    beginExit(1);
    expect(getToasts().map((t) => t.leaving)).toEqual([true, false]);
    expect(calls).toBe(1);
    beginExit(1); // already leaving → no emit
    expect(calls).toBe(1);
  });

  it("dismiss removes the matching toast; a miss does not emit", () => {
    push({ message: "a" });
    push({ message: "b" });
    let calls = 0;
    subscribe(() => { calls += 1; });
    dismiss(1);
    expect(getToasts().map((t) => t.id)).toEqual([2]);
    expect(calls).toBe(1);
    dismiss(999); // no such id → no emit
    expect(calls).toBe(1);
  });

  it("clear empties the list; a second clear on an empty list does not emit", () => {
    push({ message: "a" });
    let calls = 0;
    subscribe(() => { calls += 1; });
    clear();
    expect(getToasts()).toEqual([]);
    expect(calls).toBe(1);
    clear();
    expect(calls).toBe(1);
  });
});
