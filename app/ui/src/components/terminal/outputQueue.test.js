import { describe, it, expect } from "vitest";
import { createOutputQueue } from "./outputQueue.js";

// A queue whose sink records everything written, in order.
function sink(cap = 100) {
  const out = [];
  const queue = createOutputQueue((d) => out.push(d), cap);
  return { queue, out };
}

describe("outputQueue (held output for unopened / paused terminals)", () => {
  it("starts held and writes the queue in order on release", () => {
    const { queue, out } = sink();
    queue.push("a");
    queue.push("b");
    expect(out).toEqual([]);
    expect(queue.release()).toBe(false);
    expect(out).toEqual(["a", "b"]);
  });

  it("writes straight through once released", () => {
    const { queue, out } = sink();
    queue.release();
    queue.push("live");
    expect(out).toEqual(["live"]);
  });

  it("holds again after hold() and flushes only on the next release", () => {
    const { queue, out } = sink();
    queue.release();
    queue.hold();
    queue.push("while-hidden");
    expect(out).toEqual([]);
    queue.release();
    expect(out).toEqual(["while-hidden"]);
  });

  it("drops an overflowed queue and asks the caller to re-sync", () => {
    const { queue, out } = sink(10);
    queue.push("123456");
    queue.push("7890ab"); // 12 bytes > cap
    queue.push("more"); // ignored: the re-sync covers it
    expect(queue.release()).toBe(true);
    expect(out).toEqual([]);
    queue.push("after");
    expect(out).toEqual(["after"]);
  });

  it("re-syncs only once per overflow", () => {
    const { queue } = sink(4);
    queue.push("12345");
    expect(queue.release()).toBe(true);
    queue.hold();
    queue.push("ok");
    expect(queue.release()).toBe(false);
  });

  it("ignores empty writes", () => {
    const { queue, out } = sink();
    queue.push("");
    queue.push(null);
    queue.release();
    expect(out).toEqual([]);
  });
});
