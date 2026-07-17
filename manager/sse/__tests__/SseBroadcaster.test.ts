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

function attachFake(b: SseBroadcaster, res: FakeRes): void {
  const handle = b.attach(res as unknown as Parameters<SseBroadcaster["attach"]>[0]);
  openHandles.push(handle);
}

// Count only real "change" broadcasts, ignoring the attach preamble + keepalive.
function changeWrites(res: FakeRes): number {
  return res.writes.filter((w) => w.startsWith("event: change")).length;
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

    // Socket drains → writes resume.
    res.writeReturn = true;
    res.emit("drain");
    b.broadcast("worker:change", { a: 5 });
    assert.equal(changeWrites(res), 3, "writes resume after drain");
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
