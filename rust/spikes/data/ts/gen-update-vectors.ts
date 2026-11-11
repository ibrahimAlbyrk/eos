// Writes fixtures/update/*: cut points and chunk ids from the TypeScript
// chunker, a release (manifest, pack, signed pointer) built by the TypeScript
// publisher over an invented bundle, and the throwaway public key that signed it.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { CHUNK_AVG, CHUNK_MAX, CHUNK_MIN, ContentChunker, chunkLengths } from "../../../../core/src/domain/update/chunker.ts";
import { buildRelease } from "../../../../infra/src/update/buildRelease.ts";
import { generateUpdateSigningKey } from "../../../../infra/src/update/ed25519.ts";
import { generate, sha256, type Gen } from "./gen.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: gen-update-vectors.ts <fixtures/update>");
mkdirSync(out, { recursive: true });

// ---- chunker ------------------------------------------------------------------

const inputs: Array<{ name: string; gen: Gen }> = [
  { name: "empty", gen: { kind: "zeros", len: 0 } },
  { name: "one byte", gen: { kind: "random", seed: "a", len: 1 } },
  { name: "min - 1", gen: { kind: "random", seed: "b", len: CHUNK_MIN - 1 } },
  { name: "min", gen: { kind: "random", seed: "c", len: CHUNK_MIN } },
  { name: "min + 1", gen: { kind: "random", seed: "d", len: CHUNK_MIN + 1 } },
  { name: "avg", gen: { kind: "random", seed: "e", len: CHUNK_AVG } },
  { name: "max", gen: { kind: "random", seed: "f", len: CHUNK_MAX } },
  { name: "max + 1", gen: { kind: "random", seed: "g", len: CHUNK_MAX + 1 } },
  { name: "1 MB random", gen: { kind: "random", seed: "h", len: 1_000_000 } },
  { name: "8 MiB random", gen: { kind: "random", seed: "i", len: 8 * 1024 * 1024 } },
  { name: "zeros: every chunk is forced at max", gen: { kind: "zeros", len: 3 * CHUNK_MAX + 5 } },
  { name: "periodic 4 KiB block", gen: { kind: "repeat", seed: "j", block: 4096, len: 2_000_000 } },
  { name: "periodic 100 KB block", gen: { kind: "repeat", seed: "k", block: 100_000, len: 2_000_000 } },
  { name: "text", gen: { kind: "text", len: 3_000_000 } },
  { name: "drifting block", gen: { kind: "drift", seed: "l", block: 300_000, every: 2048, len: 1_000_000 } },
];

function lengthsInSlices(data: Uint8Array, slice: number): number[] {
  const chunker = new ContentChunker();
  const lengths: number[] = [];
  for (let at = 0; at < data.length; at += slice) lengths.push(...chunker.push(data.subarray(at, at + slice)));
  const last = chunker.end();
  if (last !== null) lengths.push(last);
  return lengths;
}

const vectors = inputs.map(({ name, gen }) => {
  const data = generate(gen);
  const lengths = chunkLengths(data);
  for (const slice of [1, 7, 4096, 65_537]) {
    if (data.length > 300_000 && slice === 1) continue;
    if (JSON.stringify(lengthsInSlices(data, slice)) !== JSON.stringify(lengths)) throw new Error(`${name}: slicing changed the cuts`);
  }
  let at = 0;
  const ids = lengths.map((len) => sha256(data.subarray(at, (at += len))));
  return { name, gen, sha256: sha256(data), lengths, ids };
});
writeFileSync(join(out, "chunker-vectors.json"), JSON.stringify(vectors, null, 1) + "\n");

// ---- a release built by the TypeScript publisher ------------------------------

const TREE: Array<{ path: string; gen?: Gen; mode?: number; dir?: true; link?: string }> = [
  { path: "Contents", dir: true },
  { path: "Contents/Info.plist", gen: { kind: "text", len: 900 } },
  { path: "Contents/MacOS", dir: true },
  { path: "Contents/MacOS/Eos", gen: { kind: "random", seed: "bin", len: 150_000 }, mode: 0o755 },
  { path: "Contents/Resources", dir: true },
  { path: "Contents/Resources/empty", gen: { kind: "zeros", len: 0 } },
  { path: "Contents/Resources/app.js", gen: { kind: "text", len: 1_200_000 } },
  { path: "Contents/Resources/ünïcode ✓.txt", gen: { kind: "text", len: 40 } },
  { path: "Contents/Resources/current", link: "app.js" },
];

const SECOND_APP_JS: Gen = { kind: "drift", seed: "app2", block: 60_000, every: 1024, len: 300_000 };

function writeTree(root: string, appJsSeed: number): void {
  for (const e of TREE) {
    const abs = join(root, e.path);
    if (e.dir) { mkdirSync(abs, { recursive: true }); chmodSync(abs, 0o755); }
    else if (e.link) symlinkSync(e.link, abs);
    else {
      // The second release rewrites app.js from top to bottom (a re-minified bundle).
      const gen: Gen = appJsSeed && e.path.endsWith("app.js") ? SECOND_APP_JS : e.gen!;
      writeFileSync(abs, generate(gen));
      chmodSync(abs, e.mode ?? 0o644);
    }
  }
}

const work = mkdtempSync(join(tmpdir(), "eos-spike-update-"));
try {
  const key = generateUpdateSigningKey();
  const feed = join(out, "feed");
  rmSync(feed, { recursive: true, force: true });
  const now = () => new Date("2026-11-11T00:00:00.000Z");

  const app1 = join(work, "1");
  mkdirSync(app1);
  writeTree(app1, 0);
  const first = await buildRelease({ appRoot: app1, version: "9.0.0", platform: "darwin-arm64", previous: null, outDir: feed, notes: "first", signingKey: key.privateKey, now, level: 3 });
  const pointer1 = readFileSync(join(feed, first.pointerPath));
  writeFileSync(join(out, "pointer-9.0.0.json"), pointer1);

  const app2 = join(work, "2");
  mkdirSync(app2);
  writeTree(app2, 2);
  const second = await buildRelease({ appRoot: app2, version: "9.0.1", platform: "darwin-arm64", previous: first.manifest, outDir: feed, notes: null, signingKey: key.privateKey, now, level: 3 });
  writeFileSync(join(out, "pointer-9.0.1.json"), readFileSync(join(feed, second.pointerPath)));
  rmSync(join(feed, "stable"), { recursive: true });

  for (const v of ["9.0.0", "9.0.1"]) {
    const zst = readFileSync(join(feed, `releases/${v}/darwin-arm64.manifest.json.zst`));
    writeFileSync(join(out, `manifest-${v}.json`), zstdDecompressSync(zst));
  }
  writeFileSync(join(out, "release.json"), JSON.stringify({
    publicKey: key.publicKey,
    tree: TREE,
    secondAppJs: SECOND_APP_JS,
    second: { wholeFiles: second.wholeFiles, newChunks: second.newChunks },
  }, null, 1) + "\n");
  console.log(JSON.stringify({ vectors: vectors.length, firstChunks: first.manifest.chunks.length, secondNew: second.newChunks, wholeFiles: second.wholeFiles }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
