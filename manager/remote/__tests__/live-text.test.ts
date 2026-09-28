import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LiveText, STOPPED_BLOCK_TTL_MS } from "../LiveText.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

class TopicBus implements EventBus {
  private subs = new Map<string, EventBusSubscriber[]>();
  publish(topic: EventBusTopic, payload: unknown): void {
    for (const fn of [...(this.subs.get(topic) ?? []), ...(this.subs.get("*") ?? [])]) fn({ topic, payload, ts: 0 });
  }
  subscribe(topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void {
    this.subs.set(topic, [...(this.subs.get(topic) ?? []), fn]);
    return () => { this.subs.set(topic, (this.subs.get(topic) ?? []).filter((f) => f !== fn)); };
  }
}

const delta = (bus: EventBus, workerId: string, blockId: string, phase: string, text = "", channel = "text") =>
  bus.publish("agent:delta", { workerId, channel, phase, blockId, text });

let clock = 0;

describe("LiveText (in-flight streaming text for the resume snapshot)", () => {
  it("accumulates start + appends and keeps the block through stop", () => {
    const bus = new TopicBus();
    const live = new LiveText(bus, () => clock);
    live.start();
    delta(bus, "w1", "b1", "start", "Hel");
    delta(bus, "w1", "b1", "append", "lo");
    delta(bus, "w1", "b1", "stop");
    delta(bus, "w1", "b2", "start", "think", "reasoning");
    assert.deepEqual(live.snapshot(), [
      { workerId: "w1", blockId: "b1", channel: "text", text: "Hello" },
      { workerId: "w1", blockId: "b2", channel: "reasoning", text: "think" },
    ]);
    live.stop();
  });

  it("seeds from an append with no start, ignores a stop for an unknown block", () => {
    const bus = new TopicBus();
    const live = new LiveText(bus, () => clock);
    live.start();
    delta(bus, "w1", "b1", "append", "mid-");
    delta(bus, "w1", "b1", "append", "stream");
    delta(bus, "w1", "b9", "stop");
    assert.deepEqual(live.snapshot().map((b) => [b.blockId, b.text]), [["b1", "mid-stream"]]);
    live.stop();
  });

  it("caps each worker at the 6 most recent blocks", () => {
    const bus = new TopicBus();
    const live = new LiveText(bus, () => clock);
    live.start();
    for (let i = 1; i <= 8; i++) delta(bus, "w1", `b${i}`, "start", String(i));
    assert.deepEqual(live.snapshot().map((b) => b.blockId), ["b3", "b4", "b5", "b6", "b7", "b8"]);
    live.stop();
  });

  it("drops a worker's blocks on worker:exit / worker:removed", () => {
    const bus = new TopicBus();
    const live = new LiveText(bus, () => clock);
    live.start();
    delta(bus, "w1", "b1", "start", "a");
    delta(bus, "w2", "b2", "start", "b");
    delta(bus, "w3", "b3", "start", "c");
    bus.publish("worker:exit", { workerId: "w1", code: 0 });
    bus.publish("worker:removed", { workerId: "w2" });
    assert.deepEqual(live.snapshot().map((b) => b.workerId), ["w3"]);
    live.stop();
    assert.deepEqual(live.snapshot(), [], "stop clears");
  });

  it("hands out copies — later deltas don't mutate a taken snapshot", () => {
    const bus = new TopicBus();
    const live = new LiveText(bus, () => clock);
    live.start();
    delta(bus, "w1", "b1", "start", "a");
    const snap = live.snapshot();
    delta(bus, "w1", "b1", "append", "b");
    assert.equal(snap[0].text, "a");
    live.stop();
  });

  it("forgets a stopped block after the TTL, keeps a streaming one", () => {
    const bus = new TopicBus();
    clock = 1_000;
    const live = new LiveText(bus, () => clock);
    live.start();
    delta(bus, "w1", "b1", "start", "done");
    delta(bus, "w1", "b1", "stop");
    delta(bus, "w2", "b2", "start", "still going");
    clock += STOPPED_BLOCK_TTL_MS - 1;
    assert.deepEqual(live.snapshot().map((b) => b.blockId), ["b1", "b2"]);
    clock += 2;
    assert.deepEqual(live.snapshot().map((b) => b.blockId), ["b2"]);
    live.stop();
  });
});
