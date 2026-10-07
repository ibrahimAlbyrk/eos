// A file transfer end to end over a real pairing: the host's daemon serves the
// real /transfer/* routes on its unix socket, the device pairs with it through
// an invite and runs the real engine with a PeerEndpoint over the HTTP/2 link.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerHostService } from "../PeerHostService.ts";
import { HostLinkService } from "../HostLinkService.ts";
import { Router } from "../../routes/Router.ts";
import { registerTransferRoutes } from "../../routes/transfer.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import { PeerEndpoint } from "../../services/transfer/PeerEndpoint.ts";
import { TransferService } from "../../services/transfer/TransferService.ts";
import { FsTransferEndpoint } from "../../../infra/src/transfer/FsTransferEndpoint.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity } from "../../../infra/src/peer/stores.ts";
import { TransferError } from "../../../core/src/domain/transfer.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { TransferRepo } from "../../../core/src/ports/TransferRepo.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";
import type { PeerConfig } from "../../../contracts/src/peer.ts";
import type { Container } from "../../container.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };
const HOST_TOKEN = "h".repeat(48);

function endpoint(home: string): FsTransferEndpoint {
  return new FsTransferEndpoint({
    home, forbidden: [join(home, ".eos")], trash: async (p) => rmSync(p, { recursive: true, force: true }),
    projects: { toKey: async (p) => `path:${p}`, findPath: async () => null },
  });
}

describe("file transfer over a real peer link", () => {
  const dir = mkdtempSync(join(tmpdir(), "eos-peer-xfer-"));
  const here = join(dir, "here");
  const there = join(dir, "there");
  const socketPath = join(dir, "host.sock");
  let hostDaemon: Server;
  let host: PeerHostService;
  let device: HostLinkService;
  let svc: TransferService;
  let peer: PeerEndpoint;
  let hostId = "";
  const peerConfig: PeerConfig = { enabled: true, direct: true, port: 0 };
  const rows = new Map<string, TransferRecord>();
  const repo: TransferRepo = {
    save: (t) => { rows.set(t.id, t); },
    get: (id) => rows.get(id) ?? null,
    list: () => [...rows.values()],
    remove: (ids) => { for (const id of ids) rows.delete(id); },
  };

  before(async () => {
    mkdirSync(here, { recursive: true });
    mkdirSync(join(there, "neon/builds"), { recursive: true });

    // The host's daemon: the real transfer routes behind its unix socket.
    const router = new Router();
    registerTransferRoutes(router, { uiToken: HOST_TOKEN, transferEndpoint: endpoint(there) } as unknown as Container);
    hostDaemon = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      try {
        await m.handler({ method: req.method ?? "GET", path: url.pathname, url, params: m.params, req, res, requestId: "t" });
      } catch (e) {
        handleError(res, e, { requestId: "t", method: req.method ?? "GET", path: url.pathname, log: silent });
      }
    });
    await new Promise<void>((resolve) => hostDaemon.listen(socketPath, resolve));

    const bus = createInMemoryEventBus();
    host = new PeerHostService({
      identity: loadOrCreateIdentity(join(dir, "host")),
      devices: createPairedDeviceStore(join(dir, "host")),
      invites: createOpenInviteStore(join(dir, "host")),
      getConfig: () => peerConfig,
      target: { socketPath, rawHost: "127.0.0.1", rawPort: 1, uiToken: HOST_TOKEN },
      servesUi: () => false,
      relayRoom: () => null,
      bus, now: () => Date.now(), log: silent,
      addresses: (port) => [`127.0.0.1:${port}`],
      keepAwake: () => () => {},
    });
    await host.reconcile();
    device = new HostLinkService({
      creds: loadOrCreateIdentity(join(dir, "device")),
      hosts: createKnownHostStore(join(dir, "device")),
      deviceName: () => "Test MacBook",
      bus, now: () => Date.now(), log: silent,
    });
    hostId = (await device.pair(host.createInvite().link, "Studio")).id;

    peer = new PeerEndpoint({ link: () => device.link(hostId), home: () => there });
    let n = 0;
    svc = new TransferService({
      repo, local: endpoint(here), peer: () => peer, hosts: device, localName: () => "Test MacBook",
      bus, clock: { now: () => Date.now() }, log: silent, newId: () => `tr-peer${String(++n).padStart(4, "0")}`, notify: () => {},
    });
  });

  after(async () => {
    device.stop();
    await host.stop();
    await new Promise<void>((resolve) => hostDaemon.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function until(id: string, status: TransferRecord["status"]): Promise<TransferRecord> {
    const start = Date.now();
    for (;;) {
      const t = svc.get(id);
      if (t.status === status) return t;
      if (Date.now() - start > 10_000) throw new Error(`stuck at ${t.status} (${t.error?.message ?? ""}), wanted ${status}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("lists the host's folders through the link", async () => {
    const l = await peer.list(join(there, "neon"));
    assert.deepEqual(l.entries.map((e) => e.name), ["builds"]);
    assert.equal(l.home, there);
  });

  it("pulls a game build — bundle, executable bit, symlink and a multi-chunk file intact", async () => {
    const app = join(there, "neon/builds/Game.app/Contents");
    mkdirSync(join(app, "MacOS"), { recursive: true });
    writeFileSync(join(app, "MacOS/Game"), "#!/bin/sh\n");
    chmodSync(join(app, "MacOS/Game"), 0o755);
    symlinkSync("MacOS/Game", join(app, "launcher"));
    const big = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    writeFileSync(join(there, "neon/builds/web.zip"), big);

    const t = await svc.start({ from: hostId, to: "local", paths: [join(there, "neon/builds/Game.app"), join(there, "neon/builds/web.zip")] });
    const done = await until(t.id, "done");
    const out = join(here, "Downloads/Eos");
    assert.equal(statSync(join(out, "Game.app/Contents/MacOS/Game")).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(out, "Game.app/Contents/launcher")), "MacOS/Game");
    assert.ok(readFileSync(join(out, "web.zip")).equals(big), "every byte arrived in order");
    assert.equal(done.route, "direct");
    assert.equal(done.doneBytes, done.totalBytes);
  });

  it("pushes a file to the host", async () => {
    writeFileSync(join(here, "notes.md"), "from the laptop");
    const t = await svc.start({ from: "local", to: hostId, paths: [join(here, "notes.md")], destDir: join(there, "inbox") });
    await until(t.id, "done");
    assert.equal(readFileSync(join(there, "inbox/notes.md"), "utf8"), "from the laptop");
    assert.equal(existsSync(join(there, "inbox/.eos-incoming")), false);
  });

  it("brings the host's own refusals back as themselves", async () => {
    await assert.rejects(peer.prepare({ id: "tr-zzzzzzzz", destDir: join(there, ".eos/x"), items: [{ rel: "a", type: "file", size: 1, mtimeMs: 0, mode: 0o644 }] }),
      (e: unknown) => e instanceof TransferError && e.code === "forbidden-dest");
  });
});
