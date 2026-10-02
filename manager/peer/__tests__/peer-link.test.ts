// End-to-end over real sockets: a host (PeerHostService in front of a fake
// local daemon on a unix socket) and a device (HostLinkService behind a real
// facade HTTP server), paired through an invite exactly as the UI does it.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGunzip } from "node:zlib";

import { PeerHostService } from "../PeerHostService.ts";
import { HostLinkService } from "../HostLinkService.ts";
import { registerHostFacade, ViewTokens } from "../facade.ts";
import { Router } from "../../routes/Router.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity } from "../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { PeerConfig } from "../../../contracts/src/peer.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const HOST_TOKEN = "h".repeat(48);
const DEVICE_TOKEN = "d".repeat(48);

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
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

function get(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d: string) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("peer link — pair, proxy, stream, revoke", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-peer-"));
  const socketPath = join(dir, "host.sock");
  const seen: Array<{ path: string; token: string | undefined; device: string | undefined; body: string }> = [];
  let localDaemon: Server;
  let facadeServer: Server;
  let facadePort = 0;
  let host: PeerHostService;
  let device: HostLinkService;
  const viewTokens = new ViewTokens();
  const notes: Array<Record<string, unknown>> = [];
  const peerConfig: PeerConfig = { enabled: true, direct: true, port: 0 };

  before(async () => {
    // The host's own daemon, as the gateway sees it: the unix-socket API.
    localDaemon = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        seen.push({ path: req.url ?? "", token: req.headers["x-eos-ui-token"] as string | undefined, device: req.headers["x-eos-peer-device"] as string | undefined, body });
        if (req.url === "/api/host") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(host.hostInfo()));
          return;
        }
        if (req.url?.includes("topics=notification:fire")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          // One the host itself raised from a Mac it controls — relaying it back
          // is what loops between mutually paired Macs.
          res.write(`id: n-1\nevent: change\ndata: ${JSON.stringify({ reason: "notification:fire", ts: 1, payload: { title: "Test MacBook · Input needed", body: "?", workerId: "w1", host: { id: "x", name: "Test MacBook" } } })}\n\n`);
          res.write(`id: n-2\nevent: change\ndata: ${JSON.stringify({ reason: "notification:fire", ts: 2, payload: { title: "Build finished", body: "all green", workerId: "w9" } })}\n\n`);
          return;
        }
        if (req.url?.startsWith("/stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let n = 0;
          const t = setInterval(() => {
            res.write(`id: e-${++n}\nevent: change\ndata: {"n":${n}}\n\n`);
            if (n === 3) { clearInterval(t); res.end(); }
          }, 15);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, method: req.method, body }));
      });
    });
    await new Promise<void>((resolve) => localDaemon.listen(socketPath, resolve));

    const bus = createInMemoryEventBus();
    bus.subscribe("notification:fire", (m) => notes.push(m.payload as Record<string, unknown>));
    const hostDir = join(dir, "host");
    host = new PeerHostService({
      identity: loadOrCreateIdentity(hostDir),
      devices: createPairedDeviceStore(hostDir),
      invites: createOpenInviteStore(hostDir),
      getConfig: () => peerConfig,
      target: { socketPath, rawHost: "127.0.0.1", rawPort: 1, uiToken: HOST_TOKEN },
      servesUi: () => false,
      relayRoom: () => null,
      bus, now: () => Date.now(), log: silent,
      addresses: (port) => [`127.0.0.1:${port}`],
      keepAwake: () => () => {},
    });
    await host.reconcile();

    const deviceDir = join(dir, "device");
    device = new HostLinkService({
      creds: loadOrCreateIdentity(deviceDir),
      hosts: createKnownHostStore(deviceDir),
      deviceName: () => "Test MacBook",
      bus, now: () => Date.now(), log: silent,
    });

    // The device's daemon: just the facade, on loopback like the real API server.
    const router = new Router();
    registerHostFacade(router, { link: (id) => device.link(id), uiToken: DEVICE_TOKEN, viewTokens });
    facadeServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      await m.handler({ method: req.method ?? "GET", path: url.pathname, url, params: m.params, req, res, requestId: "t" });
    });
    await new Promise<void>((resolve) => facadeServer.listen(0, "127.0.0.1", resolve));
    facadePort = (facadeServer.address() as AddressInfo).port;
  });

  after(async () => {
    device.stop();
    await host.stop();
    await new Promise<void>((resolve) => facadeServer.close(() => resolve()));
    await new Promise<void>((resolve) => localDaemon.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  let hostId = "";

  it("pairs through a single-use invite and brings the link up", async () => {
    const invite = host.createInvite();
    const view = await device.pair(invite.link, "Office");
    hostId = view.id;
    assert.equal(view.alias, "Office");
    assert.equal(view.deviceId, invite.deviceId);
    await waitFor(() => device.get(hostId)?.link.state === "live");
    assert.equal(device.get(hostId)?.link.route, "direct");
    assert.equal(host.devicesView()[0].name, "Test MacBook");
    await assert.rejects(device.pair(invite.link), /already used or cancelled/, "the invite works once");
  });

  it("raises the host's notifications on this Mac, tagged with the host", async () => {
    await waitFor(() => notes.length > 0);
    assert.equal(notes[0].title, "Office · Build finished");
    assert.equal(notes[0].workerId, "w9");
    assert.deepEqual(notes[0].host, { id: hostId, name: "Office" });
  });

  it("never relays a notification the host itself relayed", () => {
    assert.equal(notes.length, 1);
  });

  it("proxies requests; the host token rides only with the human dashboard's", async () => {
    const agent = await get(facadePort, `/h/${hostId}/workers?limit=3`);
    assert.equal(agent.status, 200);
    assert.deepEqual(JSON.parse(agent.body), { path: "/workers?limit=3", method: "GET", body: "" });
    const agentSeen = seen.find((s) => s.path === "/workers?limit=3");
    assert.equal(agentSeen?.token, undefined, "no ui-token for a caller without the device's own");
    assert.ok(agentSeen?.device, "the gateway names the device");

    const human = await get(facadePort, `/h/${hostId}/pty`, {
      method: "POST", body: '{"cols":80}',
      headers: { "content-type": "application/json", "x-eos-ui-token": DEVICE_TOKEN, "x-eos-peer-device": "spoofed" },
    });
    assert.equal(human.status, 200);
    const humanSeen = seen.find((s) => s.path === "/pty");
    assert.equal(humanSeen?.token, HOST_TOKEN, "host token attached for the human dashboard");
    assert.notEqual(humanSeen?.device, "spoofed", "identity header is the gateway's, never the device's");
    assert.equal(humanSeen?.body, '{"cols":80}');
  });

  it("a host view's token counts as the human only under its own host", async () => {
    const mine = viewTokens.mint(hostId);
    const other = viewTokens.mint("f".repeat(64));
    await get(facadePort, `/h/${hostId}/view-mine`, { headers: { "x-eos-ui-token": mine } });
    await get(facadePort, `/h/${hostId}/view-other`, { headers: { "x-eos-ui-token": other } });
    assert.equal(seen.find((s) => s.path === "/view-mine")?.token, HOST_TOKEN);
    assert.equal(seen.find((s) => s.path === "/view-other")?.token, undefined);
  });

  it("never forwards the local plane", async () => {
    const r = await get(facadePort, `/h/${hostId}/policy/decide`, { method: "POST", body: "{}", headers: { "x-eos-ui-token": DEVICE_TOKEN } });
    assert.equal(r.status, 403);
    assert.equal(seen.some((s) => s.path === "/policy/decide"), false);
  });

  it("streams SSE through the facade as it is written", async () => {
    const r = await get(facadePort, `/h/${hostId}/stream?since=e-0`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /text\/event-stream/);
    assert.equal((r.body.match(/event: change/g) ?? []).length, 3);
    assert.equal(r.headers["content-encoding"], undefined, "a caller that never asked for gzip gets plain frames");
  });

  it("gzips the event stream for a caller that accepts it, each frame still arriving as written", async () => {
    const r = await new Promise<{ encoding: unknown; text: string; firstAt: number; endAt: number }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: facadePort, path: `/h/${hostId}/stream?since=e-0`, headers: { "accept-encoding": "gzip" } }, (res) => {
        const gunzip = createGunzip();
        let text = "";
        let firstAt = 0;
        gunzip.setEncoding("utf8");
        gunzip.on("data", (d: string) => { text += d; if (!firstAt && text.includes("\n\n")) firstAt = Date.now(); });
        gunzip.on("end", () => resolve({ encoding: res.headers["content-encoding"], text, firstAt, endAt: Date.now() }));
        gunzip.on("error", reject);
        res.pipe(gunzip);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(r.encoding, "gzip");
    assert.equal((r.text.match(/event: change/g) ?? []).length, 3);
    // The fake daemon writes a frame every 15 ms: the first must decode long before the end.
    assert.ok(r.endAt - r.firstAt >= 15, `first frame decoded ${r.endAt - r.firstAt} ms before the end`);
  });

  it("reconnects by itself after the link drops", async () => {
    assert.equal(host.disconnect(host.devicesView()[0].fp), 1);
    await waitFor(() => device.get(hostId)?.link.state === "live" && host.devicesView()[0].connected);
    const r = await get(facadePort, `/h/${hostId}/after-drop`);
    assert.equal(r.status, 200);
  });

  it("a revoked device is told so and stops retrying", async () => {
    host.revoke(host.devicesView()[0].fp);
    await waitFor(() => device.get(hostId)?.link.state === "unauthorized");
    assert.equal(device.get(hostId)?.link.error, "not-paired");
    const r = await get(facadePort, `/h/${hostId}/workers`);
    assert.equal(r.status, 503);
    assert.equal(JSON.parse(r.body).code, "not-paired");
  });
});
