import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CHUNK_MAX, CHUNK_MIN, ContentChunker, chunkLengths } from "../domain/update/chunker.ts";
import { linkStaysInside, manifestProblem } from "../domain/update/manifest.ts";
import { RANGE_MAX_GAP, RANGE_MAX_LENGTH, coalesceSpans, planUpdate, type BundleIndex } from "../domain/update/plan.ts";
import { UPDATE_TRANSITIONS, canUpdateTransition } from "../domain/update/status.ts";
import { compareVersions, isNewerVersion } from "../domain/update/version.ts";
import { UpdateError } from "../domain/update/errors.ts";
import { checkForUpdate } from "../use-cases/update/CheckForUpdate.ts";
import { downloadUpdate } from "../use-cases/update/DownloadUpdate.ts";
import type { UpdateFeed, UpdateWorkspace } from "../ports/Updates.ts";
import { UPDATE_PHASES, type PackSpan, type UpdateChunk, type UpdateEntry, type UpdateManifest } from "../../../contracts/src/update.ts";

function randomBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

function chunkIds(data: Uint8Array): string[] {
  const ids: string[] = [];
  let offset = 0;
  for (const length of chunkLengths(data)) {
    ids.push(createHash("sha256").update(data.subarray(offset, offset + length)).digest("hex"));
    offset += length;
  }
  return ids;
}

const hash = (n: number): string => n.toString(16).padStart(64, "0");

function manifestOf(entries: UpdateEntry[], chunks: UpdateChunk[] = []): UpdateManifest {
  return { format: 1, version: "0.1.3", platform: "darwin-arm64", packs: ["packs/darwin-arm64/0.1.3.pack"], chunks, entries };
}

describe("update versions", () => {
  it("compares major.minor.patch numerically", () => {
    assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
    assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  });

  it("offers only versions above the installed one", () => {
    assert.equal(isNewerVersion("0.1.3", "0.1.2"), true);
    assert.equal(isNewerVersion("0.1.2", "0.1.2"), false);
    assert.equal(isNewerVersion("0.1.1", "0.1.2"), false);
  });
});

describe("content chunker", () => {
  const data = randomBytes(3 * 1024 * 1024, 7);

  it("cuts the same however the stream is sliced", () => {
    const chunker = new ContentChunker();
    const lengths: number[] = [];
    const slices = [1, 7, 4096, 100_000, 300_000, 65_536];
    for (let offset = 0, i = 0; offset < data.length; i++) {
      const size = slices[i % slices.length];
      lengths.push(...chunker.push(data.subarray(offset, offset + size)));
      offset += size;
    }
    const last = chunker.end();
    if (last !== null) lengths.push(last);
    assert.deepEqual(lengths, chunkLengths(data));
  });

  it("keeps every chunk within its bounds", () => {
    const lengths = chunkLengths(randomBytes(8 * 1024 * 1024, 11));
    assert.equal(lengths.reduce((a, b) => a + b, 0), 8 * 1024 * 1024);
    for (const length of lengths.slice(0, -1)) {
      assert.ok(length > CHUNK_MIN && length <= CHUNK_MAX, String(length));
    }
    const average = 8 * 1024 * 1024 / lengths.length;
    assert.ok(average > 2 * CHUNK_MIN && average < CHUNK_MAX / 2, String(average));
  });

  it("moves only the cuts around an edit", () => {
    const before = randomBytes(4 * 1024 * 1024, 23);
    const mid = 2 * 1024 * 1024;
    const after = new Uint8Array(before.length + 100);
    after.set(before.subarray(0, mid), 0);
    after.set(randomBytes(100, 5), mid);
    after.set(before.subarray(mid), mid + 100);

    const known = new Set(chunkIds(before));
    const ids = chunkIds(after);
    const shared = ids.filter((id) => known.has(id)).length;
    assert.ok(ids.length - shared <= 3, `${ids.length - shared} of ${ids.length} chunks changed`);
  });

  it("ends a short or empty stream cleanly", () => {
    assert.deepEqual(chunkLengths(new Uint8Array(0)), []);
    assert.deepEqual(chunkLengths(randomBytes(100, 3)), [100]);
  });
});

describe("update manifest checks", () => {
  const chunks: UpdateChunk[] = [
    { id: hash(1), size: 10, pack: 0, offset: 0, zsize: 6 },
    { id: hash(2), size: 5, pack: 0, offset: 6, zsize: 4 },
  ];
  const file = (path: string, size = 15, ids = [0, 1]): UpdateEntry =>
    ({ type: "file", path, mode: 0o644, size, sha256: hash(99), chunks: ids });

  it("accepts a well-formed bundle", () => {
    const m = manifestOf([
      { type: "dir", path: "Contents", mode: 0o755 },
      file("Contents/Info.plist"),
      { type: "link", path: "Contents/Frameworks/E.framework/Versions/Current", target: "A" },
      { type: "link", path: "Contents/Frameworks/E.framework/Resources", target: "Versions/Current/Resources" },
    ], chunks);
    assert.equal(manifestProblem(m), null);
  });

  it("refuses paths and links that leave the bundle", () => {
    assert.match(manifestProblem(manifestOf([file("../evil")], chunks)) ?? "", /unsafe path/);
    assert.match(manifestProblem(manifestOf([{ type: "link", path: "Contents/l", target: "../../etc" }])) ?? "", /outside/);
    assert.match(manifestProblem(manifestOf([{ type: "link", path: "Contents/l", target: "/etc" }])) ?? "", /outside/);
  });

  it("refuses writing through a link", () => {
    const m = manifestOf([{ type: "link", path: "Contents/l", target: "A" }, file("Contents/l/f")], chunks);
    assert.match(manifestProblem(m) ?? "", /under the link Contents\/l/);
  });

  it("refuses chunk references that don't add up", () => {
    assert.match(manifestProblem(manifestOf([file("a", 16)], chunks)) ?? "", /add up to 15 bytes, not 16/);
    assert.match(manifestProblem(manifestOf([file("a", 15, [0, 5])], chunks)) ?? "", /names chunk 5/);
    assert.match(manifestProblem(manifestOf([file("a"), file("a")], chunks)) ?? "", /listed twice/);
    assert.match(manifestProblem(manifestOf([], [{ ...chunks[0], pack: 3 }])) ?? "", /names pack 3/);
  });

  it("resolves a link from the folder it sits in", () => {
    assert.equal(linkStaysInside(["a", "b"], ".."), true);
    assert.equal(linkStaysInside(["a"], ".."), false);
    assert.equal(linkStaysInside(["a", "b"], "./c/../d"), true);
  });
});

describe("update plan", () => {
  // Pack 0 holds chunks 0..4 back to back; chunk 5 sits far away.
  const chunks: UpdateChunk[] = [
    { id: hash(10), size: 100, pack: 0, offset: 0, zsize: 40 },
    { id: hash(11), size: 100, pack: 0, offset: 40, zsize: 40 },
    { id: hash(12), size: 100, pack: 0, offset: 80, zsize: 40 },
    { id: hash(13), size: 100, pack: 0, offset: 120, zsize: 40 },
    { id: hash(14), size: 100, pack: 0, offset: 160, zsize: 90 },
    { id: hash(15), size: 100, pack: 0, offset: 10_000_000, zsize: 30 },
  ];
  const entry = (path: string, sha: number, ids: number[], whole?: PackSpan): UpdateEntry =>
    ({ type: "file", path, mode: 0o644, size: ids.length * 100, sha256: hash(sha), chunks: ids, ...(whole ? { whole } : {}) });

  const index: BundleIndex = {
    files: new Map([[hash(1), "Contents/Same"]]),
    chunks: new Map([
      [hash(10), { path: "Contents/Old", offset: 0, size: 100 }],
      [hash(11), { path: "Contents/Old", offset: 100, size: 100 }],
    ]),
  };

  it("copies installed files, rebuilds the rest from disk and packs", () => {
    const manifest = manifestOf([
      { type: "dir", path: "Contents", mode: 0o755 },
      entry("Contents/Same", 1, [0]),
      entry("Contents/B", 2, [0, 1, 2]),
      entry("Contents/C", 3, [2, 3]),
    ], chunks);
    const plan = planUpdate(index, manifest);

    assert.deepEqual(plan.files, [
      { kind: "copy", path: "Contents/Same", source: "Contents/Same" },
      { kind: "assemble", path: "Contents/B", parts: [{ from: "disk", path: "Contents/Old", offset: 0, size: 200 }, { from: "pack", chunk: 2 }] },
      { kind: "assemble", path: "Contents/C", parts: [{ from: "pack", chunk: 2 }, { from: "pack", chunk: 3 }] },
    ]);
    // Chunk 2 is needed twice but fetched once, in one range with chunk 3.
    assert.deepEqual(plan.ranges, [{ pack: 0, offset: 80, length: 80 }]);
    assert.equal(plan.downloadBytes, 80);
    assert.equal(plan.reusedBytes, 100 + 200);
  });

  it("takes a file whole when its chunks would cost more", () => {
    const manifest = manifestOf([entry("Contents/D", 4, [4], { pack: 0, offset: 20_000_000, zsize: 50 })], chunks);
    const plan = planUpdate(index, manifest);
    assert.deepEqual(plan.files, [{ kind: "whole", path: "Contents/D", span: { pack: 0, offset: 20_000_000, zsize: 50 } }]);
    assert.deepEqual(plan.ranges, [{ pack: 0, offset: 20_000_000, length: 50 }]);
  });

  it("downloads nothing when every chunk is on disk", () => {
    const plan = planUpdate(index, manifestOf([entry("Contents/E", 5, [1, 0])], chunks));
    assert.deepEqual(plan.ranges, []);
    assert.equal(plan.reusedBytes, 200);
  });

  it("joins nearby spans and splits far or oversized ones", () => {
    assert.deepEqual(coalesceSpans([
      { pack: 0, offset: 0, zsize: 10 },
      { pack: 0, offset: 10 + RANGE_MAX_GAP, zsize: 10 },
      { pack: 0, offset: 20 + 2 * RANGE_MAX_GAP + 1, zsize: 10 },
      { pack: 1, offset: 0, zsize: 10 },
    ]), [
      { pack: 0, offset: 0, length: 20 + RANGE_MAX_GAP },
      { pack: 0, offset: 20 + 2 * RANGE_MAX_GAP + 1, length: 10 },
      { pack: 1, offset: 0, length: 10 },
    ]);
    const big = RANGE_MAX_LENGTH - 5;
    assert.equal(coalesceSpans([{ pack: 0, offset: 0, zsize: big }, { pack: 0, offset: big, zsize: 10 }]).length, 2);
  });
});

describe("update phases", () => {
  it("lists every phase", () => {
    assert.deepEqual(Object.keys(UPDATE_TRANSITIONS).sort(), [...UPDATE_PHASES].sort());
  });

  it("allows the forward path and refuses shortcuts", () => {
    for (const [from, to] of [["idle", "checking"], ["checking", "downloading"], ["downloading", "staging"],
      ["staging", "ready"], ["ready", "waiting"], ["waiting", "applying"]] as const) {
      assert.equal(canUpdateTransition(from, to), true, `${from} → ${to}`);
    }
    assert.equal(canUpdateTransition("idle", "ready"), false);
    assert.equal(canUpdateTransition("downloading", "applying"), false);
    assert.equal(canUpdateTransition("off", "checking"), false);
    assert.equal(canUpdateTransition("ready", "ready"), true);
  });
});

describe("update use-cases", () => {
  const pointer = {
    version: "0.1.3", platform: "darwin-arm64" as const, releasedAt: "2026-10-29T12:00:00.000Z",
    manifest: { path: "releases/0.1.3/darwin-arm64.manifest.json.zst", sha256: "a".repeat(64), size: 10 },
  };
  const signed = (p: unknown) => ({ payload: JSON.stringify(p), signature: "s" });
  const feedWith = (p: unknown, extra: Partial<UpdateFeed> = {}): UpdateFeed => ({
    pointer: async () => (p === null ? null : signed(p)),
    manifest: async () => { throw new Error("unused"); },
    range: async () => new Uint8Array(),
    text: async () => "",
    ...extra,
  });
  const trusting = { verify: () => true };

  it("offers a signed, newer release for this platform only", async () => {
    assert.equal((await checkForUpdate({ feed: feedWith(pointer), signature: trusting }, { platform: "darwin-arm64", current: "0.1.2" }))?.version, "0.1.3");
    assert.equal(await checkForUpdate({ feed: feedWith(pointer), signature: trusting }, { platform: "darwin-arm64", current: "0.1.3" }), null);
    assert.equal(await checkForUpdate({ feed: feedWith(null), signature: trusting }, { platform: "darwin-arm64", current: "0.1.2" }), null);
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: UpdateError) => e.code);
    assert.equal(await code(checkForUpdate({ feed: feedWith(pointer), signature: { verify: () => false } }, { platform: "darwin-arm64", current: "0.1.2" })), "bad-signature");
    assert.equal(await code(checkForUpdate({ feed: feedWith({ ...pointer, platform: "win32-x64" }), signature: trusting }, { platform: "darwin-arm64", current: "0.1.2" })), "bad-release");
    assert.equal(await code(checkForUpdate({ feed: feedWith({ version: "nope" }), signature: trusting }, { platform: "darwin-arm64", current: "0.1.2" })), "bad-release");
  });

  it("fetches a damaged range once more, then stages", async () => {
    const chunk: UpdateChunk = { id: hash(1), size: 100, pack: 0, offset: 0, zsize: 40 };
    const manifest = manifestOf([{ type: "file", path: "Contents/a", mode: 0o644, size: 100, sha256: hash(2), chunks: [0] }], [chunk]);
    manifest.version = "0.1.3";
    let fetches = 0;
    let puts = 0;
    const stored = new Set<string>();
    const workspace: UpdateWorkspace = {
      hasRange: async (_v, r) => stored.has(`${r.pack}-${r.offset}`),
      putRange: async (_v, r) => {
        if (++puts === 1) throw new UpdateError("corrupt", "damaged");
        stored.add(`${r.pack}-${r.offset}`);
      },
      stage: async () => "/staged/Eos.app",
      staged: async () => null,
      markStaged: async () => {},
      clear: async () => {},
    };
    const progress: number[] = [];
    const staged = await downloadUpdate(
      {
        feed: feedWith(pointer, { manifest: async () => manifest, range: async () => { fetches++; return new Uint8Array(40); } }),
        indexer: { index: async () => ({ files: new Map(), chunks: new Map() }) },
        workspace,
        bundleCheck: { verify: async () => {} },
      },
      { pointer, installedRoot: "/Applications/Eos.app", onProgress: (done) => progress.push(done) },
      new AbortController().signal,
    );
    assert.equal(fetches, 2);
    assert.deepEqual(progress, [0, 40]);
    assert.deepEqual(staged, { version: "0.1.3", path: "/staged/Eos.app", bytes: 40, full: 40, notes: null });
  });
});
