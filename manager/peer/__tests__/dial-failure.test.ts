// A failed connection says why in words a person can act on — above all when
// macOS Local Network privacy is what keeps Eos off the LAN.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { blockedFromLocalNetwork, explainDialFailures } from "../dial-failure.ts";
import { HostLinkService, PairingError } from "../HostLinkService.ts";
import { encodeInvite } from "../invite-codec.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createKnownHostStore, loadOrCreateIdentity } from "../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

describe("dial failures", () => {
  it("puts the Local Network hint first and says each cause once", () => {
    const text = explainDialFailures([
      { route: "relay", code: "TIMEOUT" },
      { route: "direct", code: "EHOSTUNREACH" },
      { route: "direct", code: "EHOSTUNREACH" },
    ]);
    assert.match(text, /^macOS may be keeping Eos off the local network/);
    assert.equal(text.match(/Local Network/g)?.length, 1);
    assert.match(text, /relay can't be reached from this network$/);
  });

  it("blames Local Network privacy only for a direct no-route", () => {
    assert.equal(blockedFromLocalNetwork([{ route: "direct", code: "EHOSTUNREACH" }]), true);
    assert.equal(blockedFromLocalNetwork([{ route: "direct", code: "ECONNREFUSED" }]), false);
    assert.equal(blockedFromLocalNetwork([{ route: "relay", code: "EHOSTUNREACH" }]), false);
  });

  describe("pairing", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-dialfail-"));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("names the cause when no route reaches the host", async () => {
      // A port nothing listens on: the connect is refused.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const device = new HostLinkService({
        creds: loadOrCreateIdentity(dir),
        hosts: createKnownHostStore(dir),
        deviceName: () => "Laptop",
        bus: createInMemoryEventBus(), now: () => Date.now(), log: silent,
      });
      const invite = encodeInvite({ v: 1, fp: "a".repeat(64), sec: "s".repeat(24), name: "Office", addrs: [`127.0.0.1:${port}`] });
      await assert.rejects(device.pair(invite), (e: unknown) => {
        assert.ok(e instanceof PairingError);
        assert.equal(e.status, 502);
        assert.match(e.message, /^couldn't reach that Mac: nothing answered at its address/);
        return true;
      });
    });
  });
});
