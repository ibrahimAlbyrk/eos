import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RoomSecrets, sha256Hex } from "../keyring.ts";
import { RemoteAuditLog } from "../audit.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "../WsBridge.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eos-remote-"));
}

describe("RoomSecrets (relay v3 capability)", () => {
  it("mints room.id + bearer.secret once and reloads the same values", () => {
    const dir = tmp();
    try {
      const a = new RoomSecrets(dir);
      assert.ok(a.room.length >= 43, "room is b64url(>=32 bytes)");
      assert.ok(a.bearer.length >= 43, "bearer is b64url(>=32 bytes)");
      assert.notEqual(a.room, a.bearer);
      const b = new RoomSecrets(dir); // reload from disk, no regen
      assert.equal(b.room, a.room);
      assert.equal(b.bearer, a.bearer);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists the secret files 0600", () => {
    const dir = tmp();
    try {
      new RoomSecrets(dir);
      assert.equal(statSync(join(dir, "room.id")).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "bearer.secret")).mode & 0o777, 0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("bearerHash() is SHA-256(bearer) — the relay admission entry", () => {
    const dir = tmp();
    try {
      const s = new RoomSecrets(dir);
      assert.equal(s.bearerHash(), sha256Hex(s.bearer));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("RemoteAuditLog", () => {
  it("appends and reads back newest-last, capped", () => {
    const dir = tmp();
    try {
      const log = new RemoteAuditLog(dir);
      for (let i = 0; i < 5; i++) {
        log.append({ device: "d1", action: `POST /x/${i}`, target: String(i), ts: i, result: "ok" });
      }
      const all = log.read();
      assert.equal(all.length, 5);
      assert.equal(all[4].target, "4");
      assert.equal(log.read(2).length, 2);
      assert.equal(log.read(2)[1].target, "4"); // newest retained
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Minimal synchronous bus for the fan-out test.
class FakeBus implements EventBus {
  private subs: EventBusSubscriber[] = [];
  publish(topic: EventBusTopic, payload: unknown): void {
    for (const fn of this.subs) fn({ topic, payload, ts: 0 });
  }
  subscribe(_topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void {
    this.subs.push(fn);
    return () => { this.subs = this.subs.filter((f) => f !== fn); };
  }
}

class CaptureSession implements RemoteSession {
  readonly id: string;
  frames: ServerFrame[] = [];
  closed = false;
  constructor(id: string) { this.id = id; }
  send(frame: ServerFrame): void { this.frames.push(frame); }
  close(): void { this.closed = true; }
}

describe("WsBridge fan-out", () => {
  let bus: FakeBus;
  let bridge: WsBridge;
  beforeEach(() => {
    bus = new FakeBus();
    bridge = new WsBridge({ bus, now: () => 123 });
    bridge.start();
  });

  it("fans bus messages out as event frames with a monotonic seq", () => {
    const s1 = new CaptureSession("c1");
    const s2 = new CaptureSession("c2");
    bridge.add(s1); bridge.add(s2);
    bus.publish("worker:change", { id: "w1" });
    bus.publish("pending:created", { id: "p1" });
    assert.equal(s1.frames.length, 2);
    assert.deepEqual(s1.frames[0], { t: "event", seq: 1, reason: "worker:change", ts: 123, payload: { id: "w1" } });
    assert.equal(s1.frames[1].t === "event" && s1.frames[1].seq, 2);
    assert.equal(s2.frames.length, 2); // both sessions got the fan-out
    assert.equal(bridge.currentSeq(), 2);
  });

  it("does not allocate a seq when no sessions are connected", () => {
    bus.publish("worker:change", { id: "w1" });
    assert.equal(bridge.currentSeq(), 0);
  });

  it("stop() unsubscribes and closes sessions", () => {
    const s1 = new CaptureSession("c1");
    bridge.add(s1);
    bridge.stop();
    assert.equal(s1.closed, true);
    bus.publish("worker:change", { id: "w1" }); // no throw, no delivery
    assert.equal(s1.frames.length, 0);
    assert.equal(bridge.size(), 0);
  });
});
