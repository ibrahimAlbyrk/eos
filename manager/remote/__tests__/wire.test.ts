import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { startRemoteGateway, type RemoteWiringDeps } from "../wire.ts";
import type { EventBus, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";
import type { RemoteConfig } from "../../../contracts/src/remote.ts";

class NullBus implements EventBus {
  publish(): void {}
  subscribe(_t: unknown, _fn: EventBusSubscriber): () => void { return () => {}; }
}

function deps(home: string, remote: RemoteConfig): RemoteWiringDeps {
  return { config: { remote, daemon: { home } }, uiToken: "tok", bus: new NullBus(), log: { info() {}, warn() {} } };
}

describe("startRemoteGateway", () => {
  it("is a no-op (returns null) when mode is off — the default", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    const server = createServer();
    try {
      assert.equal(startRemoteGateway(deps(home, { mode: "off" }), {} as never, server), null);
      assert.equal(server.listenerCount("upgrade"), 0, "no /ws upgrade handler armed when off");
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("returns null when relay mode lacks url/room", () => {
    const home = mkdtempSync(join(tmpdir(), "eos-wire-"));
    const server = createServer();
    try {
      assert.equal(startRemoteGateway(deps(home, { mode: "relay" }), {} as never, server), null);
    } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
