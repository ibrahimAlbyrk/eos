import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MacIdentity, DeviceKeyring, sha256Hex } from "../keyring.ts";
import { relayDeviceId } from "../identity.ts";
import { RemoteAuditLog } from "../audit.ts";
import { WsBridge, type RemoteSession, type ServerFrame } from "../WsBridge.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eos-remote-"));
}

describe("MacIdentity", () => {
  it("generates once and reloads the same X25519 static key", () => {
    const dir = tmp();
    try {
      const a = new MacIdentity(dir);
      const pub1 = a.publicKey();
      assert.equal(pub1.length, 32);
      const b = new MacIdentity(dir); // reload from disk, no regen
      assert.equal(b.publicKey().toString("hex"), pub1.toString("hex"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("DeviceKeyring", () => {
  it("records, matches by static key, lists, builds the admission allowlist, and revokes", () => {
    const dir = tmp();
    try {
      const kr = new DeviceKeyring(dir);
      const deviceStaticPub = Buffer.alloc(32, 0xab);
      const id = relayDeviceId(deviceStaticPub);
      const rec = kr.record(deviceStaticPub, "phone", 1);
      assert.equal(rec.relayDeviceId, id);
      assert.equal(rec.deviceStaticPub, deviceStaticPub.toString("hex"));
      assert.deepEqual(kr.findByStaticPub(deviceStaticPub), rec);
      // An unknown static key is not admitted.
      assert.equal(kr.findByStaticPub(Buffer.alloc(32, 0xcd)), null);
      assert.equal(kr.list().length, 1);
      assert.deepEqual(kr.admissionHashes(), [sha256Hex(id)]);
      assert.equal(kr.revoke(id), true);
      assert.equal(kr.findByStaticPub(deviceStaticPub), null);
      assert.equal(kr.revoke(id), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a relayDeviceId that could escape the directory", () => {
    const dir = tmp();
    try {
      const kr = new DeviceKeyring(dir);
      assert.throws(() => kr.revoke("../escape"));
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

describe("WsBridge skeleton", () => {
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
