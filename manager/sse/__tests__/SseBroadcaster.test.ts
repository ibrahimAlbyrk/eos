import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { SseBroadcaster } from "../SseBroadcaster.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";

// A bus that records the "*" subscriber but never emits — tests drive
// broadcast() directly so no timing/clock is involved.
function fakeBus(): EventBus {
  return {
    publish(): void {},
    subscribe(): () => void { return (): void => {}; },
  };
}

// Minimal ServerResponse stand-in: write() returns a configurable flag and can
// throw; 'drain' is a real EventEmitter event so state.onDrain reattaches.
class FakeRes extends EventEmitter {
  writes: string[] = [];
  writeReturn = true;
  throwOnWrite = false;
  ended = false;

  writeHead(): this { return this; }
  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("EPIPE");
    this.writes.push(chunk);
    return this.writeReturn;
  }
  end(): this { this.ended = true; return this; }
}

// Track every attach so afterEach can detach() them — a live handle owns a
// keepalive setInterval that would otherwise keep the test process alive.
const openHandles: Array<{ detach(): void }> = [];
afterEach(() => {
  while (openHandles.length) openHandles.pop()?.detach();
});

function attachFake(b: SseBroadcaster, res: FakeRes, opts?: Parameters<SseBroadcaster["attach"]>[1]): void {
  const handle = b.attach(res as unknown as Parameters<SseBroadcaster["attach"]>[0], opts);
  openHandles.push(handle);
}

// Count only real "change" broadcasts, ignoring the attach preamble + keepalive.
function changeWrites(res: FakeRes): number {
  return res.writes.filter((w) => w.includes("\nevent: change\n")).length;
}

function changePayloads(res: FakeRes): unknown[] {
  return res.writes
    .filter((w) => w.includes("\nevent: change\n"))
    .map((w) => JSON.parse(w.slice(w.indexOf("data: ") + 6)).payload);
}

function lastId(res: FakeRes): string {
  const ids = res.writes.flatMap((w) => (w.startsWith("id: ") ? [w.slice(4, w.indexOf("\n"))] : []));
  return ids[ids.length - 1];
}

describe("SseBroadcaster — backpressure", () => {
  it("stops writing to a saturated client until 'drain' fires", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const res = new FakeRes();
    attachFake(b, res);

    // Healthy: write returns true → event delivered.
    b.broadcast("worker:change", { a: 1 });
    assert.equal(changeWrites(res), 1);

    // Client stops draining: next write returns false, marking it saturated.
    res.writeReturn = false;
    b.broadcast("worker:change", { a: 2 });
    assert.equal(changeWrites(res), 2, "the saturating write itself still lands");

    // While saturated, further events are dropped — no more write() calls.
    b.broadcast("worker:change", { a: 3 });
    b.broadcast("worker:change", { a: 4 });
    assert.equal(changeWrites(res), 2, "events dropped, not queued, while saturated");

    // Socket drains → the client missed events, so it is closed rather than
    // resumed with a hole; its reconnect replays them from the ring.
    res.writeReturn = true;
    res.emit("drain");
    assert.equal(res.ended, true, "a client that missed events is recycled on drain");
    assert.equal(b.size(), 0);
  });

  it("a drain with nothing missed just resumes", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const res = new FakeRes();
    attachFake(b, res);
    res.writeReturn = false;
    b.broadcast("worker:change", { a: 1 });
    res.writeReturn = true;
    res.emit("drain");
    b.broadcast("worker:change", { a: 2 });
    assert.equal(changeWrites(res), 2);
    assert.equal(res.ended, false);
  });

  it("end()s a client that stays saturated past the dropped-event threshold", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const res = new FakeRes();
    attachFake(b, res);

    res.writeReturn = false;
    b.broadcast("x", {}); // saturating write
    assert.equal(b.size(), 1);
    assert.equal(res.ended, false);

    // Drive dropped count to the 500 threshold; the 500th drop recycles it.
    for (let i = 0; i < 500; i++) b.broadcast("x", {});

    assert.equal(res.ended, true, "saturated client is end()ed");
    assert.equal(b.size(), 0, "and removed from the client set");
  });

  it("drops a client whose write() throws (broken pipe)", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const res = new FakeRes();
    attachFake(b, res);
    assert.equal(b.size(), 1);

    res.throwOnWrite = true;
    b.broadcast("x", {});
    assert.equal(b.size(), 0, "throwing client is removed");
  });

  it("delivers to healthy clients regardless of a saturated peer", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const slow = new FakeRes();
    const fast = new FakeRes();
    attachFake(b, slow);
    attachFake(b, fast);

    slow.writeReturn = false;
    b.broadcast("x", {}); // slow becomes saturated
    b.broadcast("x", {});
    b.broadcast("x", {});

    assert.equal(changeWrites(fast), 3, "fast client keeps receiving");
    assert.equal(changeWrites(slow), 1, "slow client stuck after saturation");
  });
});

describe("SseBroadcaster — resume", () => {
  it("stamps every event with a monotonic id and greets a fresh client with the current one", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    b.broadcast("worker:change", { n: 1 });
    const res = new FakeRes();
    attachFake(b, res);
    assert.ok(res.writes.some((w) => w.includes("event: hello")), "hello carries the resume point");
    assert.equal(lastId(res), b.currentId());
    b.broadcast("worker:change", { n: 2 });
    assert.equal(lastId(res), b.currentId());
  });

  it("replays exactly what a reconnecting client missed, then goes live", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const first = new FakeRes();
    attachFake(b, first);
    b.broadcast("pty:data", { n: 1 });
    const since = lastId(first);
    openHandles.pop()?.detach(); // link drops
    b.broadcast("pty:data", { n: 2 });
    b.broadcast("pty:data", { n: 3 });

    const again = new FakeRes();
    attachFake(b, again, { since });
    b.broadcast("pty:data", { n: 4 });
    assert.deepEqual(changePayloads(again), [{ n: 2 }, { n: 3 }, { n: 4 }]);
    assert.equal(again.writes.some((w) => w.includes("event: resync")), false);
  });

  it("sends resync when the gap is older than the ring or from another daemon run", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000, ringMaxEvents: 2 });
    const res = new FakeRes();
    attachFake(b, res);
    const since = lastId(res);
    for (let i = 0; i < 5; i++) b.broadcast("worker:change", { i });

    const late = new FakeRes();
    attachFake(b, late, { since });
    assert.ok(late.writes.some((w) => w.includes("event: resync")), "ring no longer covers the gap");
    assert.equal(changeWrites(late), 0);

    const stranger = new FakeRes();
    attachFake(b, stranger, { since: "deadbeef-3" });
    assert.ok(stranger.writes.some((w) => w.includes("event: resync")), "unknown epoch ⇒ resync");
  });

  it("filters by topic and topic family", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 1_000_000 });
    const res = new FakeRes();
    attachFake(b, res, { topics: ["worker:*", "notification:fire"] });
    b.broadcast("worker:change", { a: 1 });
    b.broadcast("pty:data", { a: 2 });
    b.broadcast("notification:fire", { a: 3 });
    b.broadcast("agent:delta", { a: 4 });
    assert.deepEqual(changePayloads(res), [{ a: 1 }, { a: 3 }]);
  });
});

describe("SseBroadcaster — a tab's on-screen focus", () => {
  const reasons = (res: FakeRes): string[] => res.writes
    .filter((w) => w.includes("\nevent: change\n"))
    .map((w) => { const d = JSON.parse(w.split("data: ")[1]); return `${d.reason}:${d.payload?.workerId ?? d.payload?.sessionId ?? ""}`; });

  it("streams agent:delta and pty:data only for what the tab shows; other topics as before", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 60_000 });
    const focused = new FakeRes();
    const unfocused = new FakeRes();
    attachFake(b, focused, { clientId: "tab", focus: { workers: ["w1"], ptys: ["p1"] } });
    attachFake(b, unfocused);
    b.broadcast("agent:delta", { workerId: "w1" });
    b.broadcast("agent:delta", { workerId: "w2" });
    b.broadcast("pty:data", { sessionId: "p2" });
    b.broadcast("pty:data", { sessionId: "p1" });
    b.broadcast("worker:change", { workerId: "w2" });
    assert.deepEqual(reasons(focused), ["agent:delta:w1", "pty:data:p1", "worker:change:w2"]);
    assert.equal(changeWrites(unfocused), 5, "a tab that declared nothing gets everything");
  });

  it("setFocus applies from the next event, and the replay follows the focus too", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 60_000 });
    const res = new FakeRes();
    attachFake(b, res, { clientId: "tab", focus: { workers: [], ptys: [] } });
    const since = b.currentId();
    b.broadcast("agent:delta", { workerId: "w1" });
    b.setFocus("tab", { workers: ["w1"], ptys: [] });
    b.broadcast("agent:delta", { workerId: "w1" });
    assert.equal(changeWrites(res), 1);

    const again = new FakeRes();
    attachFake(b, again, { since, clientId: "tab", focus: { workers: ["w2"], ptys: [] } });
    assert.equal(changeWrites(again), 0, "w1's deltas are not replayed to a tab now showing w2");
  });

  it("streams a visual answer's genui:delta under the same focus as agent:delta; genui:change to every tab", () => {
    const b = new SseBroadcaster({ bus: fakeBus(), keepaliveMs: 60_000 });
    const focused = new FakeRes();
    const unfocused = new FakeRes();
    attachFake(b, focused, { clientId: "tab", focus: { workers: ["w1"], ptys: [] } });
    attachFake(b, unfocused);
    b.broadcast("genui:delta", { workerId: "w1", callId: "c1", name: "mcp__orchestrator__present", phase: "append", text: "{" });
    b.broadcast("genui:delta", { workerId: "w2", callId: "c2", name: "mcp__worker__present", phase: "append", text: "{" });
    b.broadcast("genui:change", { viewId: "v_abcdefghijkl", state: { day: 2 } });
    assert.deepEqual(reasons(focused), ["genui:delta:w1", "genui:change:"]);
    assert.equal(changeWrites(unfocused), 3, "a tab that declared nothing gets everything");
  });
});
