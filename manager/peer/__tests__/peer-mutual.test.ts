// Two Macs that control each other, over real sockets, wired as container.ts
// wires them. The case that motivated it: the Pro can dial the Air, but the Air
// has no path to the Pro at all (no listener, no relay — as when macOS keeps the
// Air's Eos off the LAN). The Air still reaches the Pro, through a tunnel the
// Pro opens inside its own link to the Air. And one pairing sets up both ways.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { PeerHostService } from "../PeerHostService.ts";
import { HostLinkService } from "../HostLinkService.ts";
import { registerHostFacade } from "../facade.ts";
import { pairWith } from "../pair-mutual.ts";
import { Router } from "../../routes/Router.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity } from "../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { PeerConfig } from "../../../contracts/src/peer.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > ms) { reject(new Error("timed out waiting")); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// One Mac: its daemon's local API (a stub on a unix socket), both peering roles,
// and the /h/ facade its dashboard talks to.
async function machine(root: string, name: string, cfg: PeerConfig) {
  const dir = join(root, name);
  const seen: Array<{ path: string; device: string | undefined }> = [];
  const identity = loadOrCreateIdentity(dir);
  const devices = createPairedDeviceStore(dir);
  const hosts = createKnownHostStore(dir);
  const socketPath = join(root, `${name}.sock`);
  const local = createServer((req, res) => {
    seen.push({ path: req.url ?? "", device: req.headers["x-eos-peer-device"] as string | undefined });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/host" ? peerHost.hostInfo() : { path: req.url, machine: name }));
  });
  await new Promise<void>((resolve) => local.listen(socketPath, resolve));

  const bus = createInMemoryEventBus();
  const peerHost: PeerHostService = new PeerHostService({
    identity, devices,
    invites: createOpenInviteStore(dir),
    getConfig: () => cfg,
    target: { socketPath, rawHost: "127.0.0.1", rawPort: 1, uiToken: "t".repeat(48) },
    servesUi: () => false,
    relayRoom: () => null,
    onReverse: (fp) => hostLinks.reverseFrom(fp),
    onDeviceAllowed: (fp) => hostLinks.offerReverse(fp),
    onReciprocal: (device) => hostLinks.adoptReciprocal(device),
    bus, now: () => Date.now(), log: silent,
    addresses: (port) => [`127.0.0.1:${port}`],
    keepAwake: () => () => {},
  });
  const hostLinks: HostLinkService = new HostLinkService({
    creds: identity, hosts,
    deviceName: () => name,
    reverseSink: (fp) => (peerHost.allowsControlFrom(fp) ? (pipe) => peerHost.acceptPipe(pipe) : null),
    bus, now: () => Date.now(), log: silent,
  });

  const router = new Router();
  registerHostFacade(router, { link: (id) => hostLinks.link(id), uiToken: "d".repeat(48) });
  const facade: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = router.match(req.method ?? "GET", url.pathname);
    if (!m) { res.writeHead(404); res.end(); return; }
    await m.handler({ method: req.method ?? "GET", path: url.pathname, url, params: m.params, req, res, requestId: "t" });
  });
  await new Promise<void>((resolve) => facade.listen(0, "127.0.0.1", resolve));

  return {
    name, cfg, seen, devices, hosts, peerHost, hostLinks,
    fp: identity.fingerprint,
    facadePort: (facade.address() as AddressInfo).port,
    async start(): Promise<void> {
      await peerHost.reconcile();
      hostLinks.start();
    },
    async close(): Promise<void> {
      hostLinks.stop();
      await peerHost.stop();
      for (const s of [facade, local]) {
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

type Machine = Awaited<ReturnType<typeof machine>>;

describe("reverse tunnel — reaching a Mac with no path of your own", () => {
  const root = mkdtempSync(join(tmpdir(), "eos-mutual-"));
  let air: Machine;
  let pro: Machine;

  before(async () => {
    air = await machine(root, "air", { enabled: true, direct: true, port: 0 });
    // Hosting, but nothing reaches it: no listener, no relay.
    pro = await machine(root, "pro", { enabled: true, direct: false, port: 0 });
    // Paired the other way round earlier (from a network where that worked).
    pro.devices.upsert({ fp: air.fp, name: "air", platform: "darwin", pairedAt: Date.now(), lastSeenAt: null });
    air.hosts.upsert({ id: pro.fp, name: "pro", alias: null, platform: "darwin", addrs: [], pairedAt: Date.now(), lastConnectedAt: null });
    await air.start();
    await pro.start();
  });

  after(async () => {
    await air.close();
    await pro.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("the Air has no route to the Pro on its own", async () => {
    await waitFor(() => air.hostLinks.get(pro.fp)?.link.error === "no-route");
    assert.notEqual(air.hostLinks.get(pro.fp)?.link.state, "live");
  });

  it("reaches the Pro through the tunnel the Pro opens in its own link", async () => {
    await pro.hostLinks.pair(air.peerHost.createInvite().link);
    await waitFor(() => air.hostLinks.get(pro.fp)?.link.state === "live");
    assert.equal(air.hostLinks.get(pro.fp)?.link.route, "reverse");
    const r = await get(air.facadePort, `/h/${pro.fp}/workers`);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { path: "/workers", machine: "pro" });
    assert.equal(pro.seen.find((s) => s.path === "/workers")?.device, air.fp, "the Pro's gateway names the Air");
    assert.equal(pro.hostLinks.get(air.fp)?.link.route, "direct", "the carrying link stays direct");
  });

  it("comes back by itself after the carrying link drops", async () => {
    const before = air.hostLinks.get(pro.fp)!.link.since;
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(air.peerHost.disconnect(pro.fp) > 0);
    await waitFor(() => {
      const link = air.hostLinks.get(pro.fp)?.link;
      return link?.since !== before && link?.state === "live" && link.route === "reverse";
    });
    assert.equal(pro.hostLinks.get(air.fp)?.link.state, "live");
    const r = await get(air.facadePort, `/h/${pro.fp}/after-drop`);
    assert.equal(r.status, 200);
  });

  it("no caller on this Mac can speak the tunnel protocol through the facade", async () => {
    const r = await get(air.facadePort, `/h/${pro.fp}/peer/reverse`);
    assert.equal(r.status, 404);
  });

  it("a Mac that revokes the other stops carrying it in", async () => {
    pro.peerHost.revoke(air.fp);
    await waitFor(() => air.hostLinks.get(pro.fp)?.link.state !== "live");
    // Past the re-offer window: the Pro offers no new tunnel, so no way back in.
    await new Promise((r) => setTimeout(r, 1_500));
    assert.notEqual(air.hostLinks.get(pro.fp)?.link.state, "live");
    assert.equal(pro.hostLinks.get(air.fp)?.link.state, "live", "the Pro still controls the Air");
  });
});

describe("one pairing, both directions", () => {
  const root = mkdtempSync(join(tmpdir(), "eos-both-"));
  const machines: Machine[] = [];
  const boot = async (name: string, cfg: PeerConfig): Promise<Machine> => {
    const m = await machine(root, name, cfg);
    await m.start();
    machines.push(m);
    return m;
  };

  after(async () => {
    for (const m of machines) await m.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("the redeeming Mac lets the inviting one control it back", async () => {
    const office = await boot("office", { enabled: true, direct: true, port: 0 });
    const laptop = await boot("laptop", { enabled: true, direct: true, port: 0 });
    const view = await pairWith(laptop.peerHost, laptop.hostLinks, office.peerHost.createInvite().link, { mutual: true });
    assert.equal(view.mutual, true);
    assert.deepEqual(laptop.peerHost.devicesView().map((d) => d.fp), [office.fp], "the laptop allows the office");
    await waitFor(() => office.hostLinks.get(laptop.fp)?.link.state === "live" && laptop.hostLinks.get(office.fp)?.link.state === "live");
    assert.equal((await get(laptop.facadePort, `/h/${office.fp}/x`)).status, 200);
    assert.equal((await get(office.facadePort, `/h/${laptop.fp}/y`)).status, 200);
    assert.equal(laptop.seen.find((s) => s.path === "/y")?.device, office.fp);
  });

  it("works even when only the redeeming Mac can dial", async () => {
    // The Air case: it can reach the Pro, the Pro has no path to it at all.
    const pro = await boot("pro2", { enabled: true, direct: true, port: 0 });
    const air = await boot("air2", { enabled: true, direct: false, port: 0 });
    const view = await pairWith(air.peerHost, air.hostLinks, pro.peerHost.createInvite().link, { mutual: true });
    assert.equal(view.mutual, true);
    await waitFor(() => pro.hostLinks.get(air.fp)?.link.state === "live");
    assert.equal(pro.hostLinks.get(air.fp)?.link.route, "reverse");
    const r = await get(pro.facadePort, `/h/${air.fp}/workers`);
    assert.deepEqual(JSON.parse(r.body), { path: "/workers", machine: "air2" });
  });

  it("stays one-way unless asked", async () => {
    const host = await boot("host3", { enabled: true, direct: true, port: 0 });
    const device = await boot("device3", { enabled: true, direct: true, port: 0 });
    const view = await pairWith(device.peerHost, device.hostLinks, host.peerHost.createInvite().link, {});
    assert.equal(view.mutual, false);
    assert.equal(host.hostLinks.get(device.fp), null);
    assert.deepEqual(device.peerHost.devicesView(), []);
  });
});
