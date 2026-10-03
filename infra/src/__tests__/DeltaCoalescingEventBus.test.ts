import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withCoalescedDeltas } from "../eventbus/DeltaCoalescingEventBus.ts";
import { createInMemoryEventBus } from "../eventbus/InMemoryEventBus.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function harness() {
  const bus = withCoalescedDeltas(createInMemoryEventBus(), { windowMs: 20 });
  const seen: Array<[string, unknown]> = [];
  bus.subscribe("*", (m) => seen.push([m.topic, m.payload]));
  const delta = (blockId: string, phase: string, text: string, at: number, workerId = "w1"): void =>
    bus.publish("agent:delta", { workerId, channel: "text", phase, blockId, text, at });
  const texts = (): string[] => seen.filter(([t]) => t === "agent:delta").map(([, p]) => (p as { text: string }).text);
  return { bus, seen, delta, texts };
}

describe("withCoalescedDeltas", () => {
  it("sends a block's first delta at once and merges the rest of each window", async () => {
    const h = harness();
    h.delta("b", "start", "He", 0);
    h.delta("b", "append", "l", 2);
    h.delta("b", "append", "lo", 3);
    assert.deepEqual(h.texts(), ["He"], "the first token is not delayed");
    await sleep(35);
    assert.deepEqual(h.texts(), ["He", "llo"]);
    const merged = h.seen[1][1] as { at: number; phase: string };
    assert.equal(merged.at, 2, "the merged delta starts where its first part did");
    assert.equal(merged.phase, "append");
  });

  it("releases held text before any other event, so nothing trails what follows it", () => {
    const h = harness();
    h.delta("b", "start", "a", 0);
    h.delta("b", "append", "b", 1);
    h.bus.publish("worker:change", { workerId: "w1" });
    h.delta("b", "stop", "", 2);
    assert.deepEqual(h.seen.map(([t, p]) => `${t}:${(p as { text?: string }).text ?? ""}`), [
      "agent:delta:a", "agent:delta:b", "worker:change:", "agent:delta:",
    ]);
  });

  it("keeps blocks apart and lets a restart through at once", async () => {
    const h = harness();
    h.delta("x", "start", "1", 0);
    h.delta("y", "start", "A", 0, "w2");
    h.delta("x", "append", "2", 1);
    h.delta("y", "append", "B", 1, "w2");
    h.delta("x", "start", "new", 0);
    assert.deepEqual(h.texts(), ["1", "A", "2", "B", "new"], "a restart releases held text first");
    h.delta("y", "append", "C", 2, "w2");
    await sleep(35);
    assert.deepEqual(h.texts(), ["1", "A", "2", "B", "new", "C"]);
  });
});
