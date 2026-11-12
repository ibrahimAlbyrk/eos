// A whole TypeScript-era computer for the interop tests: today's
// PeerHostService and HostLinkService wired as manager/container.ts wires
// them, a small "daemon" on a unix socket behind the host's gateway, and the
// real host facade on a loopback port. Everything stays on 127.0.0.1.

import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGunzip } from "node:zlib";

import { PeerHostService } from "../../../../../manager/peer/PeerHostService.ts";
import { HostLinkService, PairingError } from "../../../../../manager/peer/HostLinkService.ts";
import { pairWith } from "../../../../../manager/peer/pair-mutual.ts";
import { registerHostFacade, ViewTokens } from "../../../../../manager/peer/facade.ts";
import { Router } from "../../../../../manager/routes/Router.ts";
import { composeRouteAccess } from "../../../../../manager/routes/route-access.ts";
import { createInMemoryEventBus } from "../../../../../infra/src/eventbus/InMemoryEventBus.ts";
import {
  createKnownHostStore, createOpenInviteStore, createPairedDeviceStore, loadOrCreateIdentity, loadOrCreateRelayRoom,
} from "../../../../../infra/src/peer/stores.ts";
import type { Logger } from "../../../../../core/src/ports/Logger.ts";
import type { PeerConfig } from "../../../../../contracts/src/peer.ts";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

interface Seen {
  method: string;
  path: string;
  token: string | null;
  device: string | null;
  human: string | null;
  lastEventId: string | null;
  range: string | null;
  body: string;
}

export class Mac {
  readonly dir: string;
  readonly uiToken: string;
  readonly host: PeerHostService;
  readonly links: HostLinkService;
  readonly viewTokens: ViewTokens;
  readonly config: PeerConfig;
  readonly seen: Seen[] = [];
  readonly notes: unknown[] = [];
  // What this computer's `/stream?topics=notification:fire` raises for a computer that controls it.
  readonly raising: unknown[] = [];
  facadePort = 0;
  private readonly work: string;
  private readonly daemon: Server;
  private readonly facade: Server;
  private readonly openStreams = new Set<() => void>();

  private constructor(args: { dir: string; name: string; hosting: boolean; direct: boolean; relayUrl?: string }) {
    this.dir = args.dir;
    this.uiToken = "a".repeat(48);
    this.viewTokens = new ViewTokens(this.uiToken);
    this.config = { enabled: args.hosting, direct: args.direct, port: 0, name: args.name };
    // A short path of its own: a unix socket's path has a small limit.
    this.work = mkdtempSync(join(tmpdir(), "eos-px-"));
    const bus = createInMemoryEventBus();
    bus.subscribe("notification:fire", (m) => this.notes.push(m.payload));
    const identity = loadOrCreateIdentity(this.dir);

    // This computer's own daemon, as its gateway sees it.
    this.daemon = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const h = (name: string): string | null => (req.headers[name] as string | undefined) ?? null;
        this.seen.push({
          method: req.method ?? "", path: req.url ?? "", token: h("x-eos-ui-token"), device: h("x-eos-peer-device"),
          human: h("x-eos-peer-human"), lastEventId: h("last-event-id"), range: h("range"), body,
        });
        const url = new URL(req.url ?? "/", "http://x");
        if (url.pathname === "/api/host") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(this.host.hostInfo()));
          return;
        }
        if (url.pathname === "/stream" && url.searchParams.get("topics") === "notification:fire") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          let n = 0;
          for (const payload of this.raising) res.write(`id: n-${++n}\nevent: change\ndata: ${JSON.stringify({ reason: "notification:fire", ts: n, payload })}\n\n`);
          return; // stays open, as the real stream does
        }
        if (url.pathname === "/stream") {
          // Three events; a caller that names the last one it saw gets the rest.
          const since = Number((url.searchParams.get("since") ?? h("last-event-id") ?? "e-0").split("-")[1] ?? 0);
          res.writeHead(200, { "content-type": "text/event-stream" });
          let n = since;
          const next = (): void => {
            if (n >= 3) { res.end(); return; }
            res.write(`id: e-${++n}\nevent: change\ndata: {"n":${n}}\n\n`);
            // `hold=1`: the stream stops after one event and stays open, until the link drops.
            if (url.searchParams.get("hold") === "1") { this.openStreams.add(() => res.destroy()); return; }
            setTimeout(next, 15);
          };
          next();
          return;
        }
        if (url.pathname === "/big") {
          res.writeHead(200, { "content-type": "application/octet-stream" });
          res.end(Buffer.alloc(3 * 1024 * 1024, 7));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: req.url, method: req.method, body }));
      });
    });

    this.host = new PeerHostService({
      identity,
      devices: createPairedDeviceStore(this.dir),
      invites: createOpenInviteStore(this.dir),
      getConfig: () => this.config,
      target: { socketPath: join(this.work, "d.sock"), rawHost: "127.0.0.1", rawPort: 1, uiToken: this.uiToken, isLocalOnly: composeRouteAccess([]).isLocalOnly },
      servesUi: () => false,
      // The relay this computer is reachable through, when the test runs one.
      relayRoom: () => (args.relayUrl ? { url: args.relayUrl, ...loadOrCreateRelayRoom(this.dir) } : null),
      bus, now: () => Date.now(), log: silent,
      addresses: (port) => [`127.0.0.1:${port}`],
      keepAwake: () => () => {},
      onReverse: (fp) => this.links.reverseFrom(fp),
      onDeviceAllowed: (fp) => this.links.offerReverse(fp),
      onReciprocal: (device) => this.links.adoptReciprocal(device),
    });
    // Today's host listens on every interface; a test stays on loopback.
    const server = (this.host as unknown as { server: { listen(port: number, host?: string): Promise<AddressInfo> } }).server;
    const listen = server.listen.bind(server);
    server.listen = (port: number) => listen(port, "127.0.0.1");

    this.links = new HostLinkService({
      creds: identity,
      hosts: createKnownHostStore(this.dir),
      deviceName: () => this.host.hostInfo().name,
      reverseSink: (fp) => (this.host.allowsControlFrom(fp) ? (pipe) => this.host.acceptPipe(pipe) : null),
      bus, now: () => Date.now(), log: silent,
    });

    const router = new Router();
    registerHostFacade(router, { link: (id) => this.links.link(id), uiToken: this.uiToken, viewTokens: this.viewTokens });
    this.facade = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) { res.writeHead(404); res.end(); return; }
      await m.handler({ method: req.method ?? "GET", path: url.pathname, url, params: m.params, req, res, requestId: "t" });
    });
  }

  static async start(args: { dir: string; name: string; hosting?: boolean; direct?: boolean; relayUrl?: string }): Promise<Mac> {
    const mac = new Mac({ dir: args.dir, name: args.name, hosting: args.hosting ?? true, direct: args.direct ?? true, relayUrl: args.relayUrl });
    await new Promise<void>((resolve) => mac.daemon.listen(join(mac.work, "d.sock"), resolve));
    await new Promise<void>((resolve) => mac.facade.listen(0, "127.0.0.1", resolve));
    mac.facadePort = (mac.facade.address() as AddressInfo).port;
    await mac.host.reconcile();
    mac.links.start();
    return mac;
  }

  id(): string { return this.host.hostInfo().id; }

  async pair(invite: string, alias?: string, mutual?: boolean): Promise<unknown> {
    return pairWith(this.host, this.links, invite, { alias, mutual });
  }

  // A request to this computer's own facade, as a page in its window would
  // make it; `human` sends the dashboard's token.
  fetch(args: { path: string; method?: string; human?: boolean; token?: string; headers?: Record<string, string>; body?: string; firstChunkOnly?: boolean }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(args.headers ?? {}) };
      if (args.human) headers["x-eos-ui-token"] = this.uiToken;
      if (args.token) headers["x-eos-ui-token"] = args.token;
      const req = httpRequest({ host: "127.0.0.1", port: this.facadePort, path: args.path, method: args.method ?? "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        const gz = res.headers["content-encoding"] === "gzip";
        const body = gz ? res.pipe(createGunzip({ flush: 2, finishFlush: 2 })) : res;
        const done = (cut: boolean): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), bytes: chunks.reduce((n, c) => n + c.length, 0), cut });
        body.on("data", (d: Buffer) => {
          chunks.push(d);
          if (args.firstChunkOnly) { done(false); req.destroy(); }
        });
        body.on("end", () => done(false));
        // The link dropped mid-answer: what arrived so far is the answer.
        body.on("error", () => done(true));
        res.on("aborted", () => done(true));
        res.on("error", () => done(true));
      });
      req.on("error", (e) => { if (!args.firstChunkOnly) reject(e); });
      req.end(args.body);
    });
  }

  async stop(): Promise<void> {
    for (const end of this.openStreams) end();
    this.links.stop();
    await this.host.stop();
    this.facade.closeAllConnections();
    this.daemon.closeAllConnections();
    await new Promise<void>((resolve) => this.facade.close(() => resolve()));
    await new Promise<void>((resolve) => this.daemon.close(() => resolve()));
    rmSync(this.work, { recursive: true, force: true });
  }
}

export { PairingError };
