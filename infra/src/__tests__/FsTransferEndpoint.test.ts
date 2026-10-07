import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FsTransferEndpoint, STAGING_DIR } from "../transfer/FsTransferEndpoint.ts";
import { TransferError } from "../../../core/src/domain/transfer.ts";

const ID = "tr-abcdef123456";

function rejectsWith(code: string): (e: unknown) => boolean {
  return (e) => e instanceof TransferError && e.code === code;
}

describe("FsTransferEndpoint", () => {
  let root: string;
  let src: string;
  let dest: string;
  let eosHome: string;
  let trashed: string[];
  let ep: FsTransferEndpoint;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "eos-transfer-"));
    src = join(root, "src");
    dest = join(root, "dest");
    eosHome = join(root, ".eos");
    mkdirSync(src);
    mkdirSync(eosHome);
    trashed = [];
    ep = new FsTransferEndpoint({
      home: root,
      forbidden: [eosHome],
      trash: async (p) => { trashed.push(p); rmSync(p, { recursive: true, force: true }); },
      projects: { toKey: async (p) => `path:${p}`, findPath: async () => null },
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // An app bundle in miniature: nested folders, an executable, a framework symlink.
  function makeApp(): string {
    const app = join(src, "Game.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents/Frameworks/X.framework/Versions/A"), { recursive: true });
    writeFileSync(join(app, "Contents/MacOS/Game"), "#!/bin/sh\necho hi\n");
    chmodSync(join(app, "Contents/MacOS/Game"), 0o755);
    writeFileSync(join(app, "Contents/Info.plist"), "<plist/>");
    writeFileSync(join(app, "Contents/Frameworks/X.framework/Versions/A/X"), "lib");
    symlinkSync("A", join(app, "Contents/Frameworks/X.framework/Versions/Current"));
    writeFileSync(join(app, "Contents/empty"), "");
    utimesSync(join(app, "Contents/Info.plist"), 1_600_000_000, 1_600_000_000);
    return app;
  }

  async function copy(paths: string[], decisions: Record<string, "replace" | "keep" | "skip"> = {}) {
    const m = await ep.scan(paths);
    const prep = await ep.prepare({ id: ID, destDir: dest, items: m.items });
    const dir = (rel: string): string => paths.find((p) => p.endsWith(`/${rel.split("/", 1)[0]}`))!.replace(/\/[^/]+$/, "");
    for (const f of m.items.filter((i) => i.type === "file" && i.size > 0)) {
      let off = prep.staged[f.rel] ?? 0;
      while (off < f.size) {
        const len = Math.min(5, f.size - off);
        const bytes = await ep.read(join(dir(f.rel), f.rel), { offset: off, length: len }, f);
        off = await ep.write({ id: ID, destDir: dest, rel: f.rel, offset: off }, bytes);
      }
    }
    return { manifest: m, prep, result: await ep.commit({ id: ID, destDir: dest, decisions }) };
  }

  it("lists a folder: folders first, sizes on files, staging and dotfiles hidden", async () => {
    mkdirSync(join(src, "b-dir"));
    writeFileSync(join(src, "a.txt"), "12345");
    writeFileSync(join(src, ".secret"), "x");
    mkdirSync(join(src, STAGING_DIR));
    const l = await ep.list(src);
    assert.deepEqual(l.entries.map((e) => [e.name, e.type, e.size]), [["b-dir", "directory", null], ["a.txt", "file", 5]]);
    assert.equal(l.parent, root);
    assert.equal(l.home, root);
    assert.ok((await ep.list(src, { hidden: true })).entries.some((e) => e.name === ".secret"));
  });

  it("copies an app bundle whole: tree, executable bit, symlink, empty file, mtimes", async () => {
    const app = makeApp();
    const { manifest, result } = await copy([app]);
    assert.deepEqual(manifest.roots.map((r) => r.name), ["Game.app"]);
    assert.deepEqual(result.placed, [{ name: "Game.app", path: join(dest, "Game.app") }]);
    const out = join(dest, "Game.app/Contents");
    assert.equal(readFileSync(join(out, "MacOS/Game"), "utf8"), "#!/bin/sh\necho hi\n");
    assert.equal(statSync(join(out, "MacOS/Game")).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(out, "Frameworks/X.framework/Versions/Current")), "A");
    assert.equal(readFileSync(join(out, "empty"), "utf8"), "");
    assert.equal(Math.trunc(statSync(join(out, "Info.plist")).mtimeMs), 1_600_000_000_000);
    assert.equal(existsSync(join(dest, STAGING_DIR)), false, "staging cleaned up");
  });

  it("refuses a source that changed since its scan", async () => {
    writeFileSync(join(src, "f.txt"), "before");
    const m = await ep.scan([join(src, "f.txt")]);
    writeFileSync(join(src, "f.txt"), "after!!");
    await assert.rejects(ep.read(join(src, "f.txt"), { offset: 0, length: 3 }, m.items[0]!), rejectsWith("source-changed"));
  });

  it("only appends at the staged size, and says what it holds", async () => {
    writeFileSync(join(src, "f.txt"), "abcdef");
    const m = await ep.scan([join(src, "f.txt")]);
    await ep.prepare({ id: ID, destDir: dest, items: m.items });
    await ep.write({ id: ID, destDir: dest, rel: "f.txt", offset: 0 }, Buffer.from("abc"));
    await assert.rejects(ep.write({ id: ID, destDir: dest, rel: "f.txt", offset: 0 }, Buffer.from("abc")),
      (e: unknown) => e instanceof TransferError && e.code === "offset-mismatch" && e.have === 3);
    await assert.rejects(ep.write({ id: ID, destDir: dest, rel: "f.txt", offset: 3 }, Buffer.from("defg")), rejectsWith("bad-path"), "never more than scanned");
    await assert.rejects(ep.commit({ id: ID, destDir: dest, decisions: {} }), rejectsWith("incomplete"));
  });

  it("resumes what's staged — but restarts a file that changed in between", async () => {
    writeFileSync(join(src, "a.txt"), "aaaa");
    writeFileSync(join(src, "b.txt"), "bbbb");
    const m = await ep.scan([join(src, "a.txt"), join(src, "b.txt")]);
    await ep.prepare({ id: ID, destDir: dest, items: m.items });
    await ep.write({ id: ID, destDir: dest, rel: "a.txt", offset: 0 }, Buffer.from("aa"));
    await ep.write({ id: ID, destDir: dest, rel: "b.txt", offset: 0 }, Buffer.from("bb"));
    utimesSync(join(src, "b.txt"), 1_700_000_000, 1_700_000_000);
    const again = await ep.scan([join(src, "a.txt"), join(src, "b.txt")]);
    // A fresh endpoint: what's staged is read back from disk, as after a restart.
    const ep2 = new FsTransferEndpoint({ home: root, forbidden: [eosHome], trash: async () => {}, projects: { toKey: async (p) => p, findPath: async () => null } });
    const prep = await ep2.prepare({ id: ID, destDir: dest, items: again.items });
    assert.deepEqual(prep.staged, { "a.txt": 2 });
  });

  it("applies each decision: replace sends the old one to the Trash, keep both renames, skip leaves it", async () => {
    mkdirSync(dest);
    for (const n of ["r.txt", "k.txt", "s.txt"]) {
      writeFileSync(join(src, n), `new ${n}`);
      writeFileSync(join(dest, n), `old ${n}`);
    }
    const m = await ep.scan(["r.txt", "k.txt", "s.txt"].map((n) => join(src, n)));
    const prep = await ep.prepare({ id: ID, destDir: dest, items: m.items });
    assert.deepEqual(prep.existing.map((e) => e.name).sort(), ["k.txt", "r.txt", "s.txt"]);
    await assert.rejects(copy(["r.txt", "k.txt", "s.txt"].map((n) => join(src, n))), rejectsWith("conflict-unresolved"));
    const { result } = await copy(["r.txt", "k.txt", "s.txt"].map((n) => join(src, n)), { "r.txt": "replace", "k.txt": "keep", "s.txt": "skip" });
    assert.deepEqual(trashed, [join(realpathSync(dest), "r.txt")]);
    assert.equal(readFileSync(join(dest, "r.txt"), "utf8"), "new r.txt");
    assert.equal(readFileSync(join(dest, "k.txt"), "utf8"), "old k.txt");
    assert.equal(readFileSync(join(dest, "k 2.txt"), "utf8"), "new k.txt");
    assert.equal(readFileSync(join(dest, "s.txt"), "utf8"), "old s.txt");
    assert.deepEqual(result.skipped, ["s.txt"]);
    assert.deepEqual(result.placed.map((p) => p.name).sort(), ["k 2.txt", "r.txt"]);
  });

  it("answers a repeated commit with the same result", async () => {
    writeFileSync(join(src, "f.txt"), "hi");
    const { result } = await copy([join(src, "f.txt")]);
    assert.deepEqual(await ep.commit({ id: ID, destDir: dest, decisions: {} }), result);
  });

  it("never lands inside Eos's own data, even through a symlink", async () => {
    writeFileSync(join(src, "f.txt"), "hi");
    const m = await ep.scan([join(src, "f.txt")]);
    await assert.rejects(ep.prepare({ id: ID, destDir: join(eosHome, "x"), items: m.items }), rejectsWith("forbidden-dest"));
    symlinkSync(eosHome, join(root, "sneaky"));
    await assert.rejects(ep.prepare({ id: ID, destDir: join(root, "sneaky"), items: m.items }), rejectsWith("forbidden-dest"));
  });

  it("refuses a manifest that reaches out of its folder", async () => {
    for (const rel of ["../escape.txt", "/etc/passwd", "a/../../b"]) {
      await assert.rejects(ep.prepare({ id: ID, destDir: dest, items: [{ rel, type: "file", size: 1, mtimeMs: 0, mode: 0o644 }] }), rejectsWith("bad-path"), rel);
    }
  });

  it("never writes through a link left in the staging", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const items = [
      { rel: "a", type: "dir" as const, size: 0, mtimeMs: 0, mode: 0o755 },
      { rel: "a/b", type: "dir" as const, size: 0, mtimeMs: 0, mode: 0o755 },
      { rel: "a/b/f", type: "file" as const, size: 2, mtimeMs: 0, mode: 0o644 },
    ];
    await ep.prepare({ id: ID, destDir: dest, items });
    const staged = join(dest, STAGING_DIR, ID, "files/a/b");
    rmSync(staged, { recursive: true });
    symlinkSync(outside, staged);
    await assert.rejects(ep.write({ id: ID, destDir: dest, rel: "a/b/f", offset: 0 }, Buffer.from("hi")), rejectsWith("bad-path"));
    assert.equal(existsSync(join(outside, "f")), false);
  });

  it("refuses two picked items with the same name", async () => {
    mkdirSync(join(src, "x"));
    mkdirSync(join(src, "y"));
    writeFileSync(join(src, "x/n.txt"), "1");
    writeFileSync(join(src, "y/n.txt"), "2");
    await assert.rejects(ep.scan([join(src, "x/n.txt"), join(src, "y/n.txt")]), rejectsWith("duplicate-name"));
  });

  it("drops the staging on abort", async () => {
    writeFileSync(join(src, "f.txt"), "hi");
    const m = await ep.scan([join(src, "f.txt")]);
    await ep.prepare({ id: ID, destDir: dest, items: m.items });
    assert.ok(lstatSync(join(dest, STAGING_DIR, ID)).isDirectory());
    await ep.abort({ id: ID, destDir: dest });
    assert.equal(existsSync(join(dest, STAGING_DIR)), false);
  });
});
