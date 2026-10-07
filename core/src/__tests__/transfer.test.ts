import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TransferError, chunkLength, commonParent, conflictsOf, keepBothName, manifestRoots, matchMachine, relSegments, RateMeter, MIN_CHUNK,
} from "../domain/transfer.ts";
import { runTransfer, type RunTransferEvents } from "../use-cases/RunTransfer.ts";
import type { TransferEndpoint } from "../ports/TransferEndpoint.ts";
import type {
  ManifestItem, TransferCommitRequest, TransferDecision, TransferManifest, TransferPrepareRequest,
} from "../../../contracts/src/transfer.ts";

describe("transfer rules", () => {
  it("refuses manifest paths that could leave their folder", () => {
    assert.deepEqual(relSegments("app/Contents/Info.plist"), ["app", "Contents", "Info.plist"]);
    for (const bad of ["", "/etc/passwd", "a/../b", "../x", "a//b", "./a", "a/\0"]) assert.equal(relSegments(bad), null, bad);
  });

  it("names a Keep both copy the way Finder does", () => {
    const taken = new Set(["Report 2.pdf"]);
    assert.equal(keepBothName("Report.pdf", (n) => taken.has(n)), "Report 3.pdf");
    assert.equal(keepBothName("NeonDrift.app", () => false), "NeonDrift 2.app");
    assert.equal(keepBothName(".env", () => false), ".env 2");
    assert.equal(keepBothName("builds", () => false), "builds 2");
  });

  it("finds the folder picked items share", () => {
    assert.equal(commonParent(["/p/neon/builds/a.zip", "/p/neon/builds/B.app"]), "/p/neon/builds");
    assert.equal(commonParent(["/p/neon/builds/a.zip", "/p/neon/assets"]), "/p/neon");
    assert.equal(commonParent(["/a/x", "/b/y"]), "/");
  });

  it("totals each root and pairs conflicts with what's coming", () => {
    const items: ManifestItem[] = [
      { rel: "game", type: "dir", size: 0, mtimeMs: 5, mode: 0o755 },
      { rel: "game/a", type: "file", size: 10, mtimeMs: 6, mode: 0o644 },
      { rel: "game/b", type: "file", size: 5, mtimeMs: 6, mode: 0o644 },
      { rel: "x.zip", type: "file", size: 7, mtimeMs: 9, mode: 0o644 },
    ];
    const roots = manifestRoots(items);
    assert.deepEqual(roots.map((r) => [r.name, r.size]), [["game", 15], ["x.zip", 7]]);
    const c = conflictsOf(roots, [{ name: "x.zip", type: "file", size: 3, mtimeMs: 1 }]);
    assert.deepEqual(c, [{ name: "x.zip", existing: { type: "file", size: 3, mtimeMs: 1 }, incoming: { type: "file", size: 7, mtimeMs: 9 } }]);
  });

  it("sizes a chunk to about a second of the link, within its route's bounds", () => {
    assert.equal(chunkLength("relay", 0), 1024 * 1024);
    assert.equal(chunkLength("relay", 100 * 1024 * 1024), 4 * 1024 * 1024);
    assert.equal(chunkLength("direct", 1000), MIN_CHUNK);
    assert.equal(chunkLength("direct", 9_000_000), 9_000_000);
  });

  it("smooths the rate over half-second windows", () => {
    let now = 0;
    const m = new RateMeter(() => now);
    m.add(1000);
    assert.equal(m.rate(), 0);
    now = 500;
    m.add(0);
    assert.equal(m.rate(), 2000);
  });

  it("matches a Mac the way a person names it — never guessing between two", () => {
    const macs = [
      { id: "air", names: ["MacBook Air", "Ibrahim's MacBook Air"] },
      { id: "pro", names: ["MacBook Pro"] },
      { id: "mini", names: ["Office", "Mac mini"] },
    ];
    assert.deepEqual(matchMachine("macbook air", macs), { kind: "one", id: "air" });
    assert.deepEqual(matchMachine("my MacBook Air", macs), { kind: "one", id: "air" });
    assert.deepEqual(matchMachine("mini", macs), { kind: "one", id: "mini" });
    assert.deepEqual(matchMachine("office", macs), { kind: "one", id: "mini" });
    assert.deepEqual(matchMachine("macbook", macs), { kind: "many", ids: ["air", "pro"] });
    assert.deepEqual(matchMachine("iMac", macs), { kind: "none" });
  });
});

// A disk in memory, with the same contract as the real endpoints.
class MemoryEndpoint implements TransferEndpoint {
  readonly files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  readonly staged = new Map<string, Uint8Array>();
  readonly placed = new Map<string, Uint8Array>();
  readonly existing = new Set<string>();
  failNext = 0;
  writes = 0;
  private items: ManifestItem[] = [];

  put(path: string, text: string): void {
    this.files.set(path, { data: new TextEncoder().encode(text), mtimeMs: 1 });
  }

  async list(): Promise<never> { throw new Error("unused"); }
  async home(): Promise<string> { return "/home"; }
  async projectKey(): Promise<string | null> { return null; }
  async locate(): Promise<string | null> { return null; }

  async scan(paths: readonly string[]): Promise<TransferManifest> {
    const items: ManifestItem[] = [];
    for (const p of paths) {
      const name = p.slice(p.lastIndexOf("/") + 1);
      const under = [...this.files.keys()].filter((f) => f.startsWith(`${p}/`)).sort();
      if (under.length) {
        items.push({ rel: name, type: "dir", size: 0, mtimeMs: 1, mode: 0o755 });
        for (const f of under) items.push({ rel: `${name}${f.slice(p.length)}`, type: "file", size: this.files.get(f)!.data.byteLength, mtimeMs: 1, mode: 0o644 });
      } else {
        items.push({ rel: name, type: "file", size: this.files.get(p)!.data.byteLength, mtimeMs: 1, mode: 0o644 });
      }
    }
    const roots = manifestRoots(items);
    return { roots, items, totalBytes: roots.reduce((n, r) => n + r.size, 0), fileCount: items.filter((i) => i.type === "file").length };
  }

  async read(path: string, range: { offset: number; length: number }): Promise<Uint8Array> {
    return this.files.get(path)!.data.subarray(range.offset, range.offset + range.length);
  }

  async prepare(req: TransferPrepareRequest) {
    this.items = req.items;
    const roots = req.items.filter((i) => !i.rel.includes("/"));
    return {
      existing: roots.filter((r) => this.existing.has(r.rel)).map((r) => ({ name: r.rel, type: r.type, size: 1, mtimeMs: 0 })),
      staged: Object.fromEntries([...this.staged].map(([rel, d]) => [rel, d.byteLength])),
      freeBytes: 1e12,
    };
  }

  async write(at: { rel: string; offset: number }, data: Uint8Array): Promise<number> {
    this.writes++;
    if (this.failNext > 0) { this.failNext--; throw new TransferError("unreachable", "link dropped"); }
    const cur = this.staged.get(at.rel) ?? new Uint8Array();
    if (cur.byteLength !== at.offset) throw new TransferError("offset-mismatch", "wrong offset", cur.byteLength);
    const next = new Uint8Array(cur.byteLength + data.byteLength);
    next.set(cur);
    next.set(data, cur.byteLength);
    this.staged.set(at.rel, next);
    return next.byteLength;
  }

  async commit(req: TransferCommitRequest) {
    const placed = [];
    const skipped = [];
    for (const r of this.items.filter((i) => !i.rel.includes("/"))) {
      const d = req.decisions[r.rel];
      if (this.existing.has(r.rel) && !d) throw new TransferError("conflict-unresolved", r.rel);
      if (d === "skip") { skipped.push(r.rel); continue; }
      const name = d === "keep" ? keepBothName(r.rel, (n) => this.existing.has(n)) : r.rel;
      for (const [rel, data] of this.staged) if (rel === r.rel || rel.startsWith(`${r.rel}/`)) this.placed.set(name + rel.slice(r.rel.length), data);
      placed.push({ name, path: `/dest/${name}` });
    }
    return { placed, skipped };
  }

  async abort(): Promise<void> { this.staged.clear(); }
}

function events(over: Partial<RunTransferEvents> = {}): RunTransferEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    scanned: () => log.push("scanned"),
    prepared: ({ conflicts }) => log.push(`prepared:${conflicts.length}`),
    progress: () => {},
    decisions: async () => ({}),
    copied: () => log.push("copied"),
    committing: () => log.push("committing"),
    ...over,
  };
}

const clock = { now: () => Date.now() };
const noSleep = async (): Promise<void> => {};
const text = (d: Uint8Array | undefined): string => new TextDecoder().decode(d);

describe("runTransfer", () => {
  it("copies a folder and a file, chunk by chunk, then commits", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/game/a.txt", "x".repeat(700_000));
    src.put("/s/game/sub/b.txt", "bee");
    src.put("/s/notes.md", "hello");
    const ev = events();
    const r = await runTransfer({ source: src, dest: dst, clock, sleep: noSleep, route: () => "relay", events: ev },
      { id: "tr-aaaaaaaa", sources: ["/s/game", "/s/notes.md"], destDir: "/dest" }, new AbortController().signal);
    assert.deepEqual(r.placed.map((p) => p.name), ["game", "notes.md"]);
    assert.equal(text(dst.placed.get("game/a.txt")).length, 700_000);
    assert.equal(text(dst.placed.get("game/sub/b.txt")), "bee");
    assert.equal(text(dst.placed.get("notes.md")), "hello");
    assert.deepEqual(ev.log, ["scanned", "prepared:0", "copied", "committing"]);
  });

  it("rides out a dropped link and carries on from what landed", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/big.bin", "z".repeat(3_000_000));
    dst.failNext = 2;
    await runTransfer({ source: src, dest: dst, clock, sleep: noSleep, route: () => "relay", events: events() },
      { id: "tr-bbbbbbbb", sources: ["/s/big.bin"], destDir: "/dest" }, new AbortController().signal);
    assert.equal(dst.placed.get("big.bin")?.byteLength, 3_000_000);
  });

  it("resumes from the bytes the destination already holds", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/f.txt", "abcdef");
    dst.staged.set("f.txt", new TextEncoder().encode("abc"));
    let reported = -1;
    await runTransfer({ source: src, dest: dst, clock, sleep: noSleep, route: () => "direct",
      events: events({ prepared: ({ doneBytes }) => { reported = doneBytes; } }) },
    { id: "tr-cccccccc", sources: ["/s/f.txt"], destDir: "/dest" }, new AbortController().signal);
    assert.equal(reported, 3);
    assert.equal(text(dst.placed.get("f.txt")), "abcdef");
    assert.equal(dst.writes, 1, "only the missing tail crossed");
  });

  it("gives up as unreachable once the link stays down past the outage window", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/f.txt", "abc");
    dst.failNext = 1_000;
    let now = 0;
    await assert.rejects(
      runTransfer({ source: src, dest: dst, clock: { now: () => (now += 1_000) }, sleep: noSleep, route: () => "relay", events: events(), outageMs: 5_000 },
        { id: "tr-dddddddd", sources: ["/s/f.txt"], destDir: "/dest" }, new AbortController().signal),
      (e: unknown) => e instanceof TransferError && e.code === "unreachable",
    );
  });

  it("copies while a conflict waits, and commits with the user's decision", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/a.zip", "new");
    dst.existing.add("a.zip");
    let decide: (d: Record<string, TransferDecision>) => void = () => {};
    const ev = events({ decisions: () => new Promise((resolve) => { decide = resolve; }) });
    const run = runTransfer({ source: src, dest: dst, clock, sleep: noSleep, route: () => "direct", events: ev },
      { id: "tr-eeeeeeee", sources: ["/s/a.zip"], destDir: "/dest" }, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(ev.log, ["scanned", "prepared:1", "copied"], "staged, waiting on the decision");
    decide({ "a.zip": "keep" });
    const r = await run;
    assert.deepEqual(r.placed, [{ name: "a 2.zip", path: "/dest/a 2.zip" }]);
  });

  it("stops at once when aborted, keeping what's staged", async () => {
    const src = new MemoryEndpoint();
    const dst = new MemoryEndpoint();
    src.put("/s/f.txt", "abc");
    dst.existing.add("f.txt");
    const ctl = new AbortController();
    const ev = events({ decisions: () => new Promise(() => {}) });
    const run = runTransfer({ source: src, dest: dst, clock, sleep: noSleep, route: () => "direct", events: ev },
      { id: "tr-ffffffff", sources: ["/s/f.txt"], destDir: "/dest" }, ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    const reason = Symbol("pause");
    ctl.abort(reason);
    await assert.rejects(run, (e: unknown) => e === reason);
    assert.equal(text(dst.staged.get("f.txt")), "abc");
  });
});
