// Boot auto-arm: daemon.ts constructs RemoteController and calls reconcile()
// once at startup — an enabled config with a relay URL arms the relay edge with
// NO manual POST /api/remote/arm step. These tests drive that exact call.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteController } from "../controller.ts";
import type { RemoteWiringDeps } from "../wire.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";
import type { RemoteConfig } from "../../../contracts/src/remote.ts";

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

function deps(home: string, remote: RemoteConfig): RemoteWiringDeps {
  return { config: { remote, daemon: { home, port: 7400 } }, uiToken: "tok", bus: new NullBus(), log: { info() {}, warn() {} } };
}

describe("RemoteController — boot reconcile (auto-arm)", () => {
  it("arms at boot when config.remote is enabled with a relay URL", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-ctrl-"));
    const ctrl = new RemoteController(deps(home, { enabled: true, relay: { url: "wss://relay.example/" } }), {} as never);
    try {
      assert.deepEqual(ctrl.reconcile(), { enabled: true, armed: true });
      assert.ok(ctrl.current(), "gateway handle live after boot reconcile");
    } finally {
      ctrl.disarm();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stays disarmed at boot when disabled (or URL missing)", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-ctrl-"));
    try {
      const off = new RemoteController(deps(home, { enabled: false, relay: { url: "wss://relay.example/" } }), {} as never);
      assert.deepEqual(off.reconcile(), { enabled: false, armed: false });
      assert.equal(off.current(), null);

      const noUrl = new RemoteController(deps(home, { enabled: true }), {} as never);
      assert.deepEqual(noUrl.reconcile(), { enabled: true, armed: false });
      assert.equal(noUrl.current(), null);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("re-reconcile after a config flip arms/disarms live (the arm-route path)", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-ctrl-"));
    const d = deps(home, { enabled: false });
    const ctrl = new RemoteController(d, {} as never);
    try {
      assert.equal(ctrl.reconcile().armed, false);
      // reloadConfig() reassigns config.remote in the container; mirror that.
      d.config.remote = { enabled: true, relay: { url: "wss://relay.example/" } };
      assert.equal(ctrl.reconcile().armed, true);
      d.config.remote = { enabled: false };
      assert.equal(ctrl.reconcile().armed, false);
      assert.equal(ctrl.current(), null);
    } finally {
      ctrl.disarm();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
