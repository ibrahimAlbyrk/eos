// Stale relay-session pruning (round 5). The relay drops a dead device from its
// routing table without telling the daemon, and its error frames carry no
// clientId — so the daemon prunes on activity TTL instead: any inbound data
// frame (ka/hello/control) refreshes lastActivityAt; pruneStaleSessions sweeps
// sessions idle past SESSION_IDLE_TTL_MS out of the conns map AND the bridge
// fan-out. Daemon-only: no wire change, works against an unmodified relay.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { pruneStaleSessions, SESSION_IDLE_TTL_MS } from "../wire.ts";
import { GatewayConnection, type GatewayDeps } from "../gateway.ts";
import { WsBridge } from "../WsBridge.ts";
import { RemoteAuditLog } from "../audit.ts";
import { Dir, FrameType, encodeEnvelope, parseEnvelope } from "../envelope.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

const ROOM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function kaEnvelope(clientId: Buffer): Buffer {
  return encodeEnvelope({
    type: FrameType.data, dir: Dir.c2s, epoch: 0, seq: 0n, room: ROOM, clientId,
    payload: Buffer.from(JSON.stringify({ t: "ka", ts: 0 }), "utf8"),
  });
}

describe("stale relay-session pruning (activity TTL)", () => {
  it("prunes an idle session past the TTL and keeps one with fresh ka activity", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-prune-"));
    try {
      let clock = 1_000;
      const deps: GatewayDeps = {
        audit: new RemoteAuditLog(dir), uiToken: "tok",
        routeDispatch: async () => ({ status: 200, body: {} }),
        bus: new NullBus(), room: ROOM, now: () => clock,
      };
      const bridge = new WsBridge({ bus: deps.bus, now: deps.now });
      bridge.start();

      const conns = new Map<string, GatewayConnection>();
      const mkConn = (): string => {
        const clientId = randomBytes(16);
        const hex = clientId.toString("hex");
        const conn = new GatewayConnection({
          deps, bridge, clientId, joinAck: false, send: () => {},
          close: () => { conns.get(hex)?.dispose(); conns.delete(hex); },
        });
        conns.set(hex, conn);
        conn.start();
        return hex;
      };
      const stale = mkConn();
      const alive = mkConn();
      assert.equal(bridge.size(), 2);

      // The live phone keepalives just before the sweep; the stale one is silent.
      clock += SESSION_IDLE_TTL_MS;
      conns.get(alive)!.onEnvelope(parseEnvelope(kaEnvelope(Buffer.from(alive, "hex"))));
      clock += 1;

      const pruned = pruneStaleSessions(conns, clock);
      assert.deepEqual(pruned, [stale], "only the silent session is pruned");
      assert.equal(conns.has(stale), false, "pruned session left the dispatch map");
      assert.equal(conns.has(alive), true, "active session survives");
      assert.equal(bridge.size(), 1, "pruned session left the bridge fan-out");

      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps every session while all are within the TTL", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-prune-"));
    try {
      let clock = 0;
      const deps: GatewayDeps = {
        audit: new RemoteAuditLog(dir), uiToken: "tok",
        routeDispatch: async () => ({ status: 200, body: {} }),
        bus: new NullBus(), room: ROOM, now: () => clock,
      };
      const bridge = new WsBridge({ bus: deps.bus, now: deps.now });
      bridge.start();
      const conns = new Map<string, GatewayConnection>();
      const clientId = randomBytes(16);
      const conn = new GatewayConnection({
        deps, bridge, clientId, joinAck: false, send: () => {}, close: () => {},
      });
      conns.set(clientId.toString("hex"), conn);
      conn.start();

      clock += SESSION_IDLE_TTL_MS; // exactly at the boundary — not past it
      assert.deepEqual(pruneStaleSessions(conns, clock), []);
      assert.equal(conns.size, 1);
      assert.equal(bridge.size(), 1);

      bridge.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
