// End-to-end through the real relay server (relay/server.ts, in-process): a host
// reachable only via its relay room, a device that pairs and links through it,
// the relay seeing nothing but ciphertext, revocation, and the move to a direct
// path once one opens.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { createRelay } from "../../../relay/server.ts";
import { loadConfig } from "../../../relay/config.ts";
import { PeerHostService } from "../PeerHostService.ts";
import { HostLinkService } from "../HostLinkService.ts";
import { registerHostFacade } from "../facade.ts";
import { Router } from "../../routes/Router.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity, loadOrCreateRelayRoom } from "../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { PeerConfig } from "../../../contracts/src/peer.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const SECRET_BODY = "top-secret-worker-list";

function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (cond()) { resolve(); return; }
      if (Date.now() - start > ms) { reject(new Error("timed out waiting")); return; }
      setTimeout(tick, 25);
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

describe("peer link through the relay", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-relay-"));
  const socketPath = join(dir, "h.sock");
  let relay: ReturnType<typeof createRelay>;
  let relayUrl = "";
  const relayBytes: Buffer[] = [];
  let localDaemon: Server;
  let facade: Server;
  let facadePort = 0;
  let host: PeerHostService;
  let device: HostLinkService;
  const cfg: PeerConfig = { enabled: true, direct: false, port: 0 };
  let hostId = "";

  before(async () => {
    relay = createRelay({ ...loadConfig({}), host: "127.0.0.1", port: 0, vaultPath: ":memory:" });
    await new Promise<void>((resolve) => relay.httpServer.listen(0, "127.0.0.1", resolve));
    relayUrl = `ws://127.0.0.1:${(relay.httpServer.address() as AddressInfo).port}`;
    // Everything the relay forwards, as the relay operator would see it.
    relay.wss.on("connection", (ws) => ws.on("message", (d) => relayBytes.push(Buffer.from(d as Buffer))));

    localDaemon = createServer((req, res) => {
      if (req.url === "/api/host") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(host.hostInfo())); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, note: SECRET_BODY }));
    });
    await new Promise<void>((resolve) => localDaemon.listen(socketPath, resolve));

    const bus = createInMemoryEventBus();
    const hostDir = join(dir, "host");
    const room = loadOrCreateRelayRoom(hostDir);
    host = new PeerHostService({
      identity: loadOrCreateIdentity(hostDir),
      devices: createPairedDeviceStore(hostDir),
      invites: createOpenInviteStore(hostDir),
      getConfig: () => cfg,
      target: { socketPath, rawHost: "127.0.0.1", rawPort: 1, uiToken: "t".repeat(48) },
      servesUi: () => false,
      relayRoom: () => ({ url: relayUrl, ...room }),
      bus, now: () => Date.now(), log: silent,
      addresses: (port) => [`127.0.0.1:${port}`],
      keepAwake: () => () => {},
    });
    await host.reconcile();
    await waitFor(() => host.status().relay?.online === true);

    const deviceDir = join(dir, "device");
    device = new HostLinkService({
      creds: loadOrCreateIdentity(deviceDir),
      hosts: createKnownHostStore(deviceDir),
      deviceName: () => "Laptop",
      bus, now: () => Date.now(), log: silent,
    });
    const router = new Router();
    registerHostFacade(router, { link: (id) => device.link(id), uiToken: "d".repeat(48) });
    facade = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      await m.handler({ method: req.method ?? "GET", path: url.pathname, url, params: m.params, req, res, requestId: "t" });
    });
    await new Promise<void>((resolve) => facade.listen(0, "127.0.0.1", resolve));
    facadePort = (facade.address() as AddressInfo).port;
  });

  after(async () => {
    device.stop();
    await host.stop();
    relay.wss.close();
    for (const s of [facade, localDaemon, relay.httpServer]) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("pairs through the relay with no direct path at all", async () => {
    const invite = host.createInvite();
    const view = await device.pair(invite.link);
    hostId = view.id;
    assert.equal(view.hasRelay, true);
    await waitFor(() => device.get(hostId)?.link.state === "live");
    assert.equal(device.get(hostId)?.link.route, "relay");
  });

  it("proxies requests over the relay; the relay only ever sees ciphertext", async () => {
    const r = await get(facadePort, `/h/${hostId}/workers`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).note, SECRET_BODY);
    const seen = Buffer.concat(relayBytes).toString("latin1");
    assert.ok(relayBytes.length > 0, "traffic did cross the relay");
    assert.equal(seen.includes(SECRET_BODY), false, "response body never visible to the relay");
    assert.equal(seen.includes("/workers"), false, "request path never visible to the relay");
  });

  it("moves to a direct path as soon as one opens", async () => {
    cfg.direct = true;
    await host.reconcile();
    // The device learns direct addresses the way a re-pair or Settings would.
    device.update(hostId, { addrs: host.status().addrs });
    device.kickAll();
    await waitFor(() => device.get(hostId)?.link.route === "direct");
    const r = await get(facadePort, `/h/${hostId}/after-upgrade`);
    assert.equal(r.status, 200);
  });

  it("a revoked device is turned away at the relay and stops retrying", async () => {
    cfg.direct = false;
    await host.reconcile();
    device.update(hostId, { addrs: [] });
    host.revoke(host.devicesView()[0].fp);
    await waitFor(() => device.get(hostId)?.link.state === "unauthorized");
    assert.equal(device.get(hostId)?.link.error, "not-paired");
  });
});
