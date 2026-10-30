import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import { checkForUpdate } from "../../../core/src/use-cases/update/CheckForUpdate.ts";
import { downloadUpdate } from "../../../core/src/use-cases/update/DownloadUpdate.ts";
import { scanBundle } from "../update/bundleScan.ts";
import { buildRelease } from "../update/buildRelease.ts";
import { Ed25519UpdateSignature, generateUpdateSigningKey, publicKeyOf, signUpdatePayload } from "../update/ed25519.ts";
import { FsBundleIndexer } from "../update/FsBundleIndexer.ts";
import { FsUpdateWorkspace, treeMismatch } from "../update/FsUpdateWorkspace.ts";
import { HttpUpdateFeed } from "../update/HttpUpdateFeed.ts";
import { hostPlatform } from "../platform/index.ts";

function noise(n: number, seed: number): Buffer {
  const out = Buffer.allocUnsafe(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

// Repeats farther apart than a chunk: whole, the file compresses far better
// than cut into chunks (like a bundle that inlines the same module twice).
function longRepeats(seed: number): Buffer {
  const block = noise(100_000, seed);
  return Buffer.concat(Array.from({ length: 6 }, (_, i) => {
    const copy = Buffer.from(block);
    copy[i * 1000] ^= 0xff;
    return copy;
  }));
}

async function makeBundle(root: string, files: Record<string, Buffer>, links: Record<string, string>, modes: Record<string, number> = {}): Promise<void> {
  await rm(root, { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
    await chmod(join(root, path), modes[path] ?? 0o644);
  }
  for (const [path, target] of Object.entries(links)) await symlink(target, join(root, path));
}

function serve(dir: string): Promise<{ server: Server; base: string; served: () => number }> {
  let served = 0;
  const server = createServer(async (req, res) => {
    const path = join(dir, decodeURIComponent(new URL(req.url!, "http://x").pathname));
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return void res.writeHead(404).end();
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, st.size - 1];
    served += b - a + 1;
    res.writeHead(m ? 206 : 200, { "content-length": b - a + 1, ...(m ? { "content-range": `bytes ${a}-${b}/${st.size}` } : {}) });
    createReadStream(path, { start: a, end: b }).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, served: () => served });
  }));
}

describe("update signature", () => {
  it("verifies what its key signed and nothing else", () => {
    const { privateKey, publicKey } = generateUpdateSigningKey();
    const other = generateUpdateSigningKey();
    assert.equal(publicKeyOf(privateKey), publicKey);
    const sig = signUpdatePayload('{"version":"0.1.3"}', privateKey);
    assert.equal(new Ed25519UpdateSignature([publicKey]).verify('{"version":"0.1.3"}', sig), true);
    assert.equal(new Ed25519UpdateSignature([publicKey]).verify('{"version":"9.9.9"}', sig), false);
    assert.equal(new Ed25519UpdateSignature([other.publicKey]).verify('{"version":"0.1.3"}', sig), false);
    assert.equal(new Ed25519UpdateSignature([other.publicKey, publicKey]).verify('{"version":"0.1.3"}', sig), true);
  });
});

describe("bundle scan", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "eos-scan-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("lists every entry, cuts files into contiguous chunks", async () => {
    const root = join(dir, "A.app");
    await makeBundle(root, { "Contents/big.bin": noise(700_000, 1), "Contents/x": Buffer.from("hi") }, { "Contents/link": "x" }, { "Contents/x": 0o755 });
    const entries = await scanBundle(root, { chunks: true });
    assert.deepEqual(entries.map((e) => `${e.type}:${e.path}`), ["dir:Contents", "file:Contents/big.bin", "link:Contents/link", "file:Contents/x"]);
    const big = entries[1];
    assert.ok(big.type === "file" && big.chunks.length > 1);
    if (big.type === "file") {
      let at = 0;
      for (const c of big.chunks) {
        assert.equal(c.offset, at);
        at += c.size;
      }
      assert.equal(at, 700_000);
    }
    const plain = await scanBundle(root, { chunks: false });
    assert.equal(plain[1].type === "file" && plain[1].sha256, big.type === "file" && big.sha256);
    if (hostPlatform.appUpdates?.fileModes !== false) assert.equal(plain[3].type === "file" && plain[3].mode, 0o755);
  });
});

describe("update feed + workspace, end to end", () => {
  let dir: string;
  let feedDir: string;
  let http: Awaited<ReturnType<typeof serve>>;
  const key = generateUpdateSigningKey();

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "eos-update-"));
    feedDir = join(dir, "feed");
    http = await serve(feedDir);
  });
  after(async () => {
    http.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("updates v1 to v2 fetching only what changed, byte for byte", async () => {
    const shared = noise(2_000_000, 7);
    const v1 = join(dir, "v1/Eos.app");
    const v2 = join(dir, "v2/Eos.app");
    await makeBundle(v1, {
      "Contents/MacOS/Eos": shared, "Contents/Resources/ui.js": longRepeats(2), "Contents/Resources/gone.txt": Buffer.from("old"),
    }, { "Contents/Current": "MacOS" });
    const edited = Buffer.concat([shared.subarray(0, 1_000_000), Buffer.from("signature moved"), shared.subarray(1_000_000)]);
    await makeBundle(v2, {
      "Contents/MacOS/Eos": edited, "Contents/Resources/ui.js": longRepeats(3), "Contents/Resources/new.txt": Buffer.from("new"),
    }, { "Contents/Current": "Resources" }, { "Contents/MacOS/Eos": 0o755 });

    const now = () => new Date("2026-10-29T12:00:00Z");
    const r1 = await buildRelease({ appRoot: v1, version: "0.1.1", platform: "darwin-arm64", previous: null, outDir: feedDir, notes: null, signingKey: key.privateKey, now, level: 3 });
    const r2 = await buildRelease({ appRoot: v2, version: "0.1.2", platform: "darwin-arm64", previous: r1.manifest, outDir: feedDir, notes: "# 0.1.2\n", signingKey: key.privateKey, now, level: 3 });
    assert.ok(r2.packBytes < r1.packBytes / 2, `${r2.packBytes} vs ${r1.packBytes}`);
    assert.equal(r2.wholeFiles, 1, "ui.js was rewritten: cheaper whole");

    const feed = new HttpUpdateFeed({ baseUrl: () => http.base });
    const signature = new Ed25519UpdateSignature([key.publicKey]);
    const pointer = await checkForUpdate({ feed, signature }, { platform: "darwin-arm64", current: "0.1.1" });
    assert.equal(pointer?.version, "0.1.2");
    assert.equal(await checkForUpdate({ feed, signature: new Ed25519UpdateSignature([generateUpdateSigningKey().publicKey]) }, { platform: "darwin-arm64", current: "0.1.1" }).catch((e: UpdateError) => e.code), "bad-signature");

    const workspace = new FsUpdateWorkspace(join(dir, "updates"));
    let total = -1;
    const before = http.served();
    const staged = await downloadUpdate(
      { feed, indexer: new FsBundleIndexer(), workspace, bundleCheck: { verify: async () => {} } },
      { pointer: pointer!, installedRoot: v1, onProgress: (_d, t) => { total = t; } },
      new AbortController().signal,
    );
    assert.ok(total > 0 && total < 400_000, `planned ${total}`);
    assert.ok(http.served() - before < 600_000, `served ${http.served() - before}`);
    assert.equal(treeMismatch(r2.manifest.entries, await scanBundle(staged.path, { chunks: false })), null);
    assert.equal((await readFile(join(staged.path, "Contents/MacOS/Eos"))).equals(edited), true);
    assert.equal(staged.notes, "# 0.1.2\n");
    assert.deepEqual(await workspace.staged(), staged);
  });
});

describe("http update feed", () => {
  const ok = (body: string, status = 200, headers: Record<string, string> = {}): Response => new Response(body, { status, headers });

  it("retries a server error, then gives up as a network failure", async () => {
    let calls = 0;
    const feed = new HttpUpdateFeed({
      baseUrl: () => "https://feed.test",
      fetch: async () => (++calls < 3 ? ok("", 503) : ok("{}")),
      sleep: async () => {},
    });
    await assert.rejects(feed.pointer("darwin-arm64"), (e: UpdateError) => e.code === "bad-release");
    assert.equal(calls, 3);

    const down = new HttpUpdateFeed({ baseUrl: () => "https://feed.test", fetch: async () => { throw new TypeError("fetch failed"); }, sleep: async () => {} });
    await assert.rejects(down.pointer("darwin-arm64"), (e: UpdateError) => e.code === "network" && e.transient);
  });

  it("treats a missing pointer as no release, and refuses a server that ignores ranges", async () => {
    const feed = new HttpUpdateFeed({ baseUrl: () => "https://feed.test", fetch: async () => ok("", 404) });
    assert.equal(await feed.pointer("darwin-arm64"), null);
    const noRanges = new HttpUpdateFeed({ baseUrl: () => "https://feed.test", fetch: async () => ok("whole file") });
    await assert.rejects(noRanges.range("packs/x.pack", 0, 4), (e: UpdateError) => e.code === "bad-release");
  });

  it("refuses a manifest that isn't the one its pointer names", async () => {
    const feed = new HttpUpdateFeed({ baseUrl: () => "https://feed.test", fetch: async () => ok("abcd") });
    await assert.rejects(feed.manifest({ path: "releases/m.zst", sha256: "0".repeat(64), size: 4 }), (e: UpdateError) => e.code === "corrupt");
  });
});

describe("update workspace", () => {
  it("refuses fetched bytes whose chunks don't match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eos-ws-"));
    try {
      const ws = new FsUpdateWorkspace(dir);
      const manifest = {
        format: 1 as const, version: "0.1.2", platform: "darwin-arm64" as const, packs: ["p"], entries: [],
        chunks: [{ id: "a".repeat(64), size: 3, pack: 0, offset: 0, zsize: 4 }],
      };
      await assert.rejects(ws.putRange("0.1.2", { pack: 0, offset: 0, length: 4 }, Buffer.from("junk"), manifest), (e: UpdateError) => e.code === "corrupt");
      assert.equal(await ws.hasRange("0.1.2", { pack: 0, offset: 0, length: 4 }), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
