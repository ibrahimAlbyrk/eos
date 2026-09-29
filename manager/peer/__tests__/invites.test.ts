// Invites have no expiry: one made today is redeemed tomorrow, after the host's
// daemon restarted in between. They still work exactly once, and cancelling
// kills every open one.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerHostService } from "../PeerHostService.ts";
import { HostLinkService } from "../HostLinkService.ts";
import { decodeInvite } from "../invite-codec.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import {
  createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity,
} from "../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { PeerConfig } from "../../../contracts/src/peer.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

describe("peer invites", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-invites-"));
  const hostDir = join(dir, "host");
  const cfg: PeerConfig = { enabled: true, direct: true, port: 0 };
  const bus = createInMemoryEventBus();
  const running: PeerHostService[] = [];
  let clock = Date.now();

  const bootHost = async (): Promise<PeerHostService> => {
    const host = new PeerHostService({
      identity: loadOrCreateIdentity(hostDir),
      devices: createPairedDeviceStore(hostDir),
      invites: createOpenInviteStore(hostDir),
      getConfig: () => cfg,
      target: { socketPath: join(dir, "none.sock"), rawHost: "127.0.0.1", rawPort: 1, uiToken: "t".repeat(48) },
      servesUi: () => false,
      relayRoom: () => null,
      bus, now: () => clock, log: silent,
      addresses: (port) => [`127.0.0.1:${port}`],
      keepAwake: () => () => {},
    });
    await host.reconcile();
    running.push(host);
    return host;
  };
  const device = (name: string): HostLinkService => new HostLinkService({
    creds: loadOrCreateIdentity(join(dir, name)),
    hosts: createKnownHostStore(join(dir, name)),
    deviceName: () => name,
    bus, now: () => clock, log: silent,
  });

  after(async () => {
    for (const h of running) await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries no expiry", async () => {
    const host = await bootHost();
    assert.equal(decodeInvite(host.createInvite().link).exp, undefined);
    host.cancelInvites();
    await host.stop();
  });

  it("outlives a restart and a day, then works exactly once", async () => {
    const first = await bootHost();
    const { link } = first.createInvite();
    assert.equal(first.status().openInvites, 1);
    await first.stop();

    clock += 24 * 60 * 60 * 1000; // tomorrow, at the office
    const host = await bootHost();
    assert.equal(host.status().openInvites, 1, "the open invite was kept on disk");
    // The address inside the old link is gone with the old listener; the new
    // one is what the host would put in its reach today.
    const invite = decodeInvite(link);
    const relinked = link.replace(link.split("/").pop()!, Buffer.from(JSON.stringify({ ...invite, addrs: host.status().addrs })).toString("base64url"));

    const laptop = device("laptop");
    const view = await laptop.pair(relinked);
    assert.equal(view.id, host.hostInfo().id);
    assert.equal(host.status().openInvites, 0);
    await assert.rejects(device("intruder").pair(relinked), /already used or cancelled/);
    laptop.stop();
  });

  it("cancelling stops every open link", async () => {
    const host = running[running.length - 1];
    const { link } = host.createInvite();
    const invite = decodeInvite(link);
    const fresh = link.replace(link.split("/").pop()!, Buffer.from(JSON.stringify({ ...invite, addrs: host.status().addrs })).toString("base64url"));
    assert.equal(host.cancelInvites(), 1);
    await assert.rejects(device("late").pair(fresh));
  });
});
