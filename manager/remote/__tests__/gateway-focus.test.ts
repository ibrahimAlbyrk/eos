// What a phone link sends beyond the base protocol: the snapshot on join, focus
// filtering, pushed transcript rows, compressed frames and ordered keystrokes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { GatewayConnection, type GatewayDeps } from "../gateway.ts";
import { WsBridge } from "../WsBridge.ts";
import { RemoteAuditLog } from "../audit.ts";
import { Dir, FrameType, encodeEnvelope, parseEnvelope } from "../envelope.ts";
import type { RouteDispatch } from "../dispatch.ts";
import type { EventBus, EventBusSubscriber, EventBusTopic } from "../../../core/src/ports/EventBus.ts";
import { DEFLATE_MARK, type LiveBlock } from "../../../contracts/src/remote.ts";

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

const ROOM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decode(buf: Buffer): any {
  const payload = parseEnvelope(buf).payload;
  const json = payload[0] === DEFLATE_MARK ? inflateRawSync(payload.subarray(1)) : payload;
  return JSON.parse(json.toString("utf8"));
}

function harness(opts: { routeDispatch?: RouteDispatch; live?: Record<string, LiveBlock[]> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eos-gwf-"));
  const bus = new TopicBus();
  const bridge = new WsBridge({ bus, now: () => 0 });
  bridge.start();
  const clientId = randomBytes(16);
  const out: Buffer[] = [];
  const calls: string[] = [];
  const deps: GatewayDeps = {
    audit: new RemoteAuditLog(dir), uiToken: "UITOK",
    routeDispatch: async (req) => {
      calls.push(`${req.method} ${req.path}`);
      if (opts.routeDispatch) return opts.routeDispatch(req);
      if (req.path === "/pty") return { status: 200, body: { sessions: [{ sessionId: "p1" }] } };
      if (req.path === "/api/ui-config") return { status: 200, body: { theme: "x" } };
      return { status: 200, body: [] };
    },
    bus, room: ROOM, now: () => Date.now(),
    liveText: { snapshot: () => [], blocksFor: (id) => opts.live?.[id] ?? [] },
  };
  const conn = new GatewayConnection({ deps, bridge, clientId, joinAck: false, send: (b) => out.push(b), close: () => {} });
  const send = (frame: object): void => conn.onEnvelope(parseEnvelope(encodeEnvelope({
    type: FrameType.data, dir: Dir.c2s, room: ROOM, clientId, payload: Buffer.from(JSON.stringify(frame), "utf8"),
  })));
  const frames = (): any[] => out.map(decode);
  const done = (): void => { conn.dispose(); bridge.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { bus, bridge, conn, send, frames, out, calls, done };
}

describe("GatewayConnection — snapshot on join", () => {
  it("seeds the phone on join with caps, terminals and ui-config; the first hello is not answered again", async () => {
    const h = harness();
    h.conn.start();
    await tick();
    const snaps = h.frames().filter((f) => f.t === "snapshot");
    assert.equal(snaps.length, 1);
    assert.deepEqual(snaps[0].caps, ["focus", "rows", "deflate"]);
    assert.deepEqual(snaps[0].ptys, [{ sessionId: "p1" }]);
    assert.deepEqual(snaps[0].uiConfig, { theme: "x" });

    h.send({ t: "hello", lastContentId: 0, caps: ["focus"] });
    await tick();
    assert.equal(h.frames().filter((f) => f.t === "snapshot").length, 1, "first hello rides the join snapshot");

    h.send({ t: "hello", lastContentId: 0 });
    await tick();
    const later = h.frames().filter((f) => f.t === "snapshot");
    assert.equal(later.length, 2, "a later hello (gap recovery) gets a fresh snapshot");
    assert.equal(later[1].ptys, undefined, "only the join snapshot carries the extras");
    h.done();
  });
});

describe("GatewayConnection — focus", () => {
  it("sends everything until the phone says what it shows, then only what is on screen", async () => {
    const h = harness();
    h.conn.start();
    await tick();
    h.bus.publish("fs:change", { dir: "/x" });
    h.send({ t: "hello", caps: ["focus"] });
    h.send({ t: "focus", active: true, worker: "w1" });
    await tick();
    h.bus.publish("agent:delta", { workerId: "w1", blockId: "b", phase: "append", text: "a" });
    h.bus.publish("agent:delta", { workerId: "w2", blockId: "c", phase: "append", text: "b" });
    h.bus.publish("worker:change", { workerId: "w1" });
    h.bus.publish("git:change", { dir: "/x" });
    h.bus.publish("pty:session", { sessionId: "p1" });
    const events = h.frames().filter((f) => f.t === "event").map((f) => [f.reason, f.payload.workerId ?? f.payload.sessionId ?? f.payload.dir]);
    assert.deepEqual(events, [
      ["fs:change", "/x"],
      ["agent:delta", "w1"],
      ["worker:change", "w1"], // no "rows" cap: the phone still fetches on this nudge
      ["pty:session", "p1"],
    ]);
    h.done();
  });

  it("a phone showing another Mac gets state patches only", async () => {
    const h = harness();
    h.conn.start();
    await tick();
    h.send({ t: "hello", caps: ["focus"] });
    h.send({ t: "focus", active: false });
    await tick();
    const before = h.frames().length;
    h.bus.publish("agent:delta", { workerId: "w1", blockId: "b", phase: "append", text: "a" });
    h.bus.publish("pty:session", { sessionId: "p1" });
    h.bridge.pushPatch("workers", "upsert", { id: "w1" });
    assert.deepEqual(h.frames().slice(before).map((f) => f.t), ["patch"]);
    h.done();
  });

  it("pty:conversation goes to the phone with that terminal open", async () => {
    const h = harness();
    h.conn.start();
    await tick();
    h.send({ t: "hello", caps: ["focus"] });
    h.send({ t: "focus", active: true, pty: "p1" });
    await tick();
    h.bus.publish("pty:conversation", { sessionId: "p1" });
    h.bus.publish("pty:conversation", { sessionId: "p2" });
    const convs = h.frames().filter((f) => f.reason === "pty:conversation").map((f) => f.payload.sessionId);
    assert.deepEqual(convs, ["p1"]);
    h.done();
  });
});

describe("GatewayConnection — pushed transcript rows", () => {
  it("pushes the open worker's new rows and its live text, and stops the worker:change nudge", async () => {
    const rowsFor: Record<number, unknown[]> = { 5: [{ id: 6 }, { id: 7 }], 7: [{ id: 8 }] };
    const h = harness({
      live: { w1: [{ workerId: "w1", blockId: "b1", channel: "text", text: "so far" }] },
      routeDispatch: async ({ path }) => {
        const m = /^\/workers\/w1\/events\?afterId=(\d+)&limit=500$/.exec(path);
        return { status: 200, body: m ? rowsFor[Number(m[1])] ?? [] : [] };
      },
    });
    h.conn.start();
    await tick();
    h.send({ t: "hello", caps: ["focus", "rows"] });
    h.send({ t: "focus", active: true, worker: "w1", afterId: 5 });
    await tick();
    h.bus.publish("worker:change", { workerId: "w1" });
    await tick();
    h.bus.publish("worker:change", { workerId: "w2" });
    await tick();
    const rows = h.frames().filter((f) => f.t === "rows");
    assert.deepEqual(rows.map((f) => f.rows.map((r: { id: number }) => r.id)), [[], [6, 7], [8]]);
    assert.deepEqual(rows[0].live, [{ workerId: "w1", blockId: "b1", channel: "text", text: "so far" }], "live text first, at once");
    assert.equal(rows[1].live, undefined, "live text only on a focus change");
    assert.equal(h.calls.filter((c) => c.includes("/events")).length, 2, "w2's change reads nothing");
    assert.equal(h.frames().filter((f) => f.reason === "worker:change").length, 0, "no nudge with pushed rows");
    h.done();
  });

  it("while the first page loads it sends only the live text, then rows once the phone names its newest row", async () => {
    const h = harness({
      live: { w1: [{ workerId: "w1", blockId: "b1", channel: "reasoning", text: "hm" }] },
      routeDispatch: async ({ path }) => ({ status: 200, body: path.includes("afterId=9") ? [{ id: 10 }] : [] }),
    });
    h.conn.start();
    await tick();
    h.send({ t: "hello", caps: ["focus", "rows"] });
    h.send({ t: "focus", active: true, worker: "w1", afterId: null });
    await tick();
    assert.deepEqual(h.frames().filter((f) => f.t === "rows").map((f) => [f.rows.length, f.live?.length]), [[0, 1]]);
    h.send({ t: "focus", active: true, worker: "w1", afterId: 9 });
    await tick();
    const rows = h.frames().filter((f) => f.t === "rows");
    assert.deepEqual(rows[1].rows, [{ id: 10 }]);
    h.done();
  });
});

describe("GatewayConnection — compression + keystrokes", () => {
  it("compresses large frames for a phone that listed deflate", async () => {
    const h = harness();
    h.conn.start();
    await tick();
    h.send({ t: "hello", caps: ["deflate"] });
    await tick();
    const before = h.out.length;
    h.bus.publish("fs:change", { dir: "x".repeat(4000) });
    const payload = parseEnvelope(h.out[before]).payload;
    assert.equal(payload[0], DEFLATE_MARK);
    assert.ok(payload.length < 1000);
    assert.equal(decode(h.out[before]).payload.dir.length, 4000);
    h.done();
  });

  it("writes terminal input in arrival order even when a write is slow", async () => {
    const order: string[] = [];
    const h = harness({
      routeDispatch: async ({ path, body }) => {
        if (path.endsWith("/input")) {
          const data = (body as { data: string }).data;
          if (data === "a") await tick(20);
          order.push(data);
        }
        return { status: 200, body: {} };
      },
    });
    h.conn.start();
    await tick();
    const input = (data: string): void => h.send({
      t: "control", correlationId: randomUUID(),
      method: "POST", path: "/pty/p1/input", body: JSON.stringify({ data }),
    });
    input("a");
    input("b");
    await tick(40);
    assert.deepEqual(order, ["a", "b"]);
    h.done();
  });
});
