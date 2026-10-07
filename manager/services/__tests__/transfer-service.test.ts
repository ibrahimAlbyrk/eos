// Two Macs' disks, real files: this Mac's endpoint and the "host" are both the
// real FsTransferEndpoint on temp folders, so only the link is left out (the
// peer test covers that). Everything the Transfer tab and an agent rely on.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TransferService, type NotificationFire } from "../transfer/TransferService.ts";
import { FsTransferEndpoint } from "../../../infra/src/transfer/FsTransferEndpoint.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { TransferError } from "../../../core/src/domain/transfer.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { TransferEndpoint } from "../../../core/src/ports/TransferEndpoint.ts";
import type { TransferRepo } from "../../../core/src/ports/TransferRepo.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";
import type { HostView } from "../../../contracts/src/peer.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const HOST = "b".repeat(64);
const OTHER = "c".repeat(64);

class MemoryRepo implements TransferRepo {
  readonly rows = new Map<string, TransferRecord>();
  save(t: TransferRecord): void { this.rows.set(t.id, t); }
  get(id: string): TransferRecord | null { return this.rows.get(id) ?? null; }
  list(limit: number): TransferRecord[] { return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit); }
  remove(ids: readonly string[]): void { for (const id of ids) this.rows.delete(id); }
}

function host(id: string, name: string, state: HostView["link"]["state"] = "live"): HostView {
  return { id, name, alias: null, platform: "darwin", addrs: [], pairedAt: 0, lastConnectedAt: 0, deviceId: id.slice(0, 8), hasRelay: false,
    link: { state, route: "direct", rttMs: 3, since: 0, attempt: 0, error: null }, info: null } as unknown as HostView;
}

describe("TransferService", () => {
  let root: string;
  let here: string;
  let there: string;
  let local: FsTransferEndpoint;
  let remote: TransferEndpoint;
  let repo: MemoryRepo;
  let notes: NotificationFire[];
  let svc: TransferService;
  let n: number;
  let keys: { here: Map<string, string>; there: Map<string, string> };

  function endpoint(home: string, map: () => Map<string, string>): FsTransferEndpoint {
    return new FsTransferEndpoint({
      home,
      forbidden: [join(home, ".eos")],
      trash: async (p) => rmSync(p, { recursive: true, force: true }),
      projects: {
        toKey: async (p) => map().get(p) ?? `path:${p}`,
        findPath: async (k) => [...map()].find(([, v]) => v === k)?.[0] ?? null,
      },
    });
  }

  function service(over: { remote?: TransferEndpoint; hosts?: HostView[]; clock?: { now(): number } } = {}): TransferService {
    const hosts = over.hosts ?? [host(HOST, "Office")];
    return new TransferService({
      repo, local, peer: () => over.remote ?? remote,
      hosts: { list: () => hosts, get: (id) => hosts.find((h) => h.id === id) ?? null },
      localName: () => "MacBook Pro",
      bus: createInMemoryEventBus(),
      clock: over.clock ?? { now: () => Date.now() },
      log: quiet,
      newId: () => `tr-${String(++n).padStart(8, "0")}`,
      notify: (x) => notes.push(x),
      sleep: async () => {},
    });
  }

  async function until(id: string, status: TransferRecord["status"]): Promise<TransferRecord> {
    const start = Date.now();
    for (;;) {
      const t = svc.get(id);
      if (t.status === status) return t;
      if (Date.now() - start > 5000) throw new Error(`stuck at ${t.status} (${t.error?.message ?? ""}), wanted ${status}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "eos-xfer-svc-"));
    here = join(root, "here");
    there = join(root, "there");
    mkdirSync(here);
    mkdirSync(join(there, "neon/builds"), { recursive: true });
    keys = { here: new Map(), there: new Map() };
    local = endpoint(here, () => keys.here);
    remote = endpoint(there, () => keys.there);
    repo = new MemoryRepo();
    notes = [];
    n = 0;
    svc = service();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pulls a folder from the other Mac into ~/Downloads/Eos, and says so", async () => {
    mkdirSync(join(there, "neon/builds/Game.app/Contents"), { recursive: true });
    writeFileSync(join(there, "neon/builds/Game.app/Contents/run"), "go");
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/builds/Game.app")] });
    assert.equal(t.destDir, join(here, "Downloads/Eos"));
    assert.equal(t.destReason, "default");
    const done = await until(t.id, "done");
    assert.equal(readFileSync(join(here, "Downloads/Eos/Game.app/Contents/run"), "utf8"), "go");
    assert.equal(done.doneBytes, 2);
    assert.deepEqual(done.placed, [{ name: "Game.app", path: join(here, "Downloads/Eos/Game.app") }]);
    assert.equal(notes[0]?.title, "Copied to MacBook Pro");
    assert.equal(notes[0]?.route, "transfers");
  });

  it("lands in the same project when this Mac has that repo, keeping the sub-folder", async () => {
    mkdirSync(join(here, "code/neon/builds"), { recursive: true });
    keys.there.set(join(there, "neon/builds"), "git:github.com/me/neon#builds");
    keys.here.set(join(here, "code/neon/builds"), "git:github.com/me/neon#builds");
    writeFileSync(join(there, "neon/builds/web.zip"), "zip");
    const d = await svc.destination(HOST, "local", [join(there, "neon/builds/web.zip")]);
    assert.deepEqual(d, { destDir: join(here, "code/neon/builds"), reason: "project" });
  });

  it("copies while a conflict waits for the user, then keeps both", async () => {
    mkdirSync(join(here, "Downloads/Eos"), { recursive: true });
    writeFileSync(join(here, "Downloads/Eos/web.zip"), "old");
    writeFileSync(join(there, "neon/builds/web.zip"), "new!");
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/builds/web.zip")] });
    const waiting = await until(t.id, "conflict");
    assert.equal(waiting.conflicts[0]?.name, "web.zip");
    assert.equal(waiting.conflicts[0]?.incoming.size, 4);
    assert.equal(waiting.doneBytes, 4, "the bytes are already here");
    svc.decide(t.id, { "web.zip": "keep" });
    const done = await until(t.id, "done");
    assert.equal(readFileSync(join(here, "Downloads/Eos/web.zip"), "utf8"), "old");
    assert.equal(readFileSync(join(here, "Downloads/Eos/web 2.zip"), "utf8"), "new!");
    assert.equal(done.placed[0]?.name, "web 2.zip");
  });

  it("pauses with the staging kept, and resumes to the end", async () => {
    writeFileSync(join(there, "neon/a.bin"), "a".repeat(64));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: TransferEndpoint = Object.assign(Object.create(remote) as TransferEndpoint, {
      read: async (...args: Parameters<TransferEndpoint["read"]>) => { await gate; return remote.read(...args); },
    });
    svc = service({ remote: slow });
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/a.bin")] });
    await until(t.id, "copying");
    svc.pause(t.id);
    release();
    await until(t.id, "paused");
    assert.ok(existsSync(join(here, "Downloads/Eos/.eos-incoming", t.id)), "staging kept for the resume");
    svc.resume(t.id);
    await until(t.id, "done");
    assert.equal(readFileSync(join(here, "Downloads/Eos/a.bin"), "utf8"), "a".repeat(64));
  });

  it("cancel drops what was staged", async () => {
    writeFileSync(join(there, "neon/a.bin"), "abc");
    mkdirSync(join(here, "Downloads/Eos"), { recursive: true });
    writeFileSync(join(here, "Downloads/Eos/a.bin"), "mine");
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/a.bin")] });
    await until(t.id, "conflict");
    svc.cancel(t.id);
    await until(t.id, "cancelled");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(join(here, "Downloads/Eos/.eos-incoming")), false);
    assert.equal(readFileSync(join(here, "Downloads/Eos/a.bin"), "utf8"), "mine");
  });

  it("a link that stays down leaves it interrupted, resumable, with a banner", async () => {
    let now = 0;
    const down: TransferEndpoint = Object.assign(Object.create(remote) as TransferEndpoint, {
      scan: async () => { throw new TransferError("unreachable", "link dropped"); },
    });
    svc = service({ remote: down, clock: { now: () => (now += 30_000) } });
    writeFileSync(join(there, "neon/a.bin"), "abc");
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/a.bin")] });
    const stuck = await until(t.id, "interrupted");
    assert.equal(stuck.error?.code, "unreachable");
    assert.equal(notes.at(-1)?.title, "Transfer paused");
  });

  it("a hard failure says why and cleans up", async () => {
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/missing.zip")] });
    const failed = await until(t.id, "failed");
    assert.equal(failed.error?.code, "not-found");
    assert.equal(notes.at(-1)?.title, "Transfer failed");
  });

  it("an agent's send goes to ~/Downloads/Eos there and never replaces anything", async () => {
    mkdirSync(join(here, "proj"));
    writeFileSync(join(here, "proj/out.zip"), "fresh");
    mkdirSync(join(there, "Downloads/Eos"), { recursive: true });
    writeFileSync(join(there, "Downloads/Eos/out.zip"), "theirs");
    const t = await svc.sendForAgent({ id: "w1", name: "Focus", cwd: join(here, "proj") }, { machine: "office", paths: ["out.zip"] });
    assert.deepEqual([t.from, t.to, t.origin.agentId], ["local", HOST, "w1"]);
    await until(t.id, "done");
    assert.equal(readFileSync(join(there, "Downloads/Eos/out.zip"), "utf8"), "theirs");
    assert.equal(readFileSync(join(there, "Downloads/Eos/out 2.zip"), "utf8"), "fresh");
    assert.equal(notes.at(-1)?.workerId, "w1");
  });

  it("an agent naming no paired Mac — or an offline one — hears which Macs there are", async () => {
    svc = service({ hosts: [host(HOST, "Office"), host(OTHER, "MacBook Air", "offline")] });
    await assert.rejects(svc.sendForAgent({ id: "w1", name: "F", cwd: here }, { machine: "iMac", paths: ["x"] }),
      (e: unknown) => e instanceof ValidationError && /Office \(online\), MacBook Air \(offline\)/.test(e.message));
    await assert.rejects(svc.sendForAgent({ id: "w1", name: "F", cwd: here }, { machine: "air", paths: ["x"] }),
      (e: unknown) => e instanceof ValidationError && /isn't reachable/.test(e.message));
  });

  it("refuses a pair that isn't this Mac plus one paired Mac", async () => {
    await assert.rejects(svc.start({ from: HOST, to: OTHER, paths: ["/x"] }), ValidationError);
    await assert.rejects(svc.start({ from: "local", to: OTHER, paths: ["/x"] }), /isn't paired/);
  });

  it("after a restart, a transfer that was running can be resumed", () => {
    repo.save({ ...({} as TransferRecord), id: "tr-00000099", status: "copying", rate: 5, createdAt: 1 });
    svc.boot();
    assert.equal(repo.get("tr-00000099")?.status, "interrupted");
    assert.equal(repo.get("tr-00000099")?.rate, 0);
  });

  it("clears finished ones from the list", async () => {
    writeFileSync(join(there, "neon/a.bin"), "abc");
    const t = await svc.start({ from: HOST, to: "local", paths: [join(there, "neon/a.bin")] });
    await until(t.id, "done");
    assert.deepEqual(svc.clearFinished(), [t.id]);
    assert.equal(svc.list().length, 0);
  });
});
