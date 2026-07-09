import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRemoteGateway, type RemoteWiringDeps } from "../wire.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";
import type { RemoteConfig } from "../../../contracts/src/remote.ts";

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

function deps(home: string, remote: RemoteConfig): RemoteWiringDeps {
  return { config: { remote, daemon: { home, port: 7400 } }, uiToken: "tok", bus: new NullBus(), log: { info() {}, warn() {} } };
}

describe("startRemoteGateway (relay v3)", () => {
  it("is a no-op (returns null) when disabled — the default", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    try {
      assert.equal(startRemoteGateway(deps(home, { enabled: false }), {} as never), null);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("returns null when enabled but relay.url is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    try {
      assert.equal(startRemoteGateway(deps(home, { enabled: true }), {} as never), null);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("arms when enabled + relay.url, minting room.id + bearer.secret (0600) under ~/.eos/remote", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    try {
      // A dummy router is fine — the connector dials out lazily; arming just builds
      // the handle + mints secrets. No routes are matched in this test.
      const handle = startRemoteGateway(deps(home, { enabled: true, relay: { url: "wss://relay.example/" } }), {} as never);
      assert.ok(handle, "gateway arms with enabled + relay.url");
      const remoteDir = join(home, "remote");
      assert.ok(existsSync(join(remoteDir, "room.id")), "room.id persisted");
      assert.ok(existsSync(join(remoteDir, "bearer.secret")), "bearer.secret persisted");
      // The armed QR carries the minted room + bearer, v3 shape.
      const qr = handle!.armPairing({});
      assert.equal(qr.v, 3);
      assert.equal(qr.typ, "eos-pair");
      assert.equal(qr.relay, "wss://relay.example/");
      assert.equal(qr.room, readFileSync(join(remoteDir, "room.id"), "utf8").trim());
      assert.ok(qr.room.length >= 43, "room is b64url(>=32 bytes)");
      assert.ok(qr.bearer && qr.bearer.length >= 43, "bearer is b64url(>=32 bytes)");
      handle!.stop();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("reuses the same room across re-arm (persisted, survives a rebuild)", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    try {
      const cfg = deps(home, { enabled: true, relay: { url: "wss://relay.example/" } });
      const h1 = startRemoteGateway(cfg, {} as never);
      const room1 = h1!.armPairing({}).room;
      h1!.stop();
      const h2 = startRemoteGateway(cfg, {} as never);
      const room2 = h2!.armPairing({}).room;
      h2!.stop();
      assert.equal(room1, room2);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
