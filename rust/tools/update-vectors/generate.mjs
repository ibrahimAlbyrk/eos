#!/usr/bin/env node
// Writes rust/fixtures/update: what today's TypeScript chunker and release
// builder produce, so the Rust ports (eos-domain::update, eos-update, `cargo
// xtask publish-update`) can be held to them byte for byte.
//
//   node rust/tools/update-vectors/generate.mjs            write the corpus
//   node rust/tools/update-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm ci` in contracts/.
// The compressed files are zstd's output, so they are stable per libzstd
// version (Node 26 and the `zstd` crate both carry 1.5.7).
//
// chunker-vectors.json   cut points and chunk ids of 15 generated inputs
// release.json           the invented bundle (generators, not bytes), the
//                        throwaway key pair that signed it, what the builder reported
// feed/                  two releases as the builder wrote them: 9.0.0 (the feed's
//                        first: level 9) and 9.0.1 built against it (level 19, one
//                        file taken whole)
// manifest-<v>.json      each manifest, unpacked

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/update");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { CHUNK_AVG, CHUNK_MAX, CHUNK_MIN, ContentChunker, chunkLengths } = await load("core/src/domain/update/chunker.ts");
const { buildRelease } = await load("infra/src/update/buildRelease.ts");

// ---- generated inputs (the same generators are in eos-testkit's `update`) ------

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// SHA-256 in counter mode over "<seed>:<i>".
function randomBytes(seed, len) {
  const out = Buffer.alloc(len);
  for (let i = 0, at = 0; at < len; i++, at += 32) {
    createHash("sha256").update(`${seed}:${i}`).digest().copy(out, at, 0, Math.min(32, len - at));
  }
  return out;
}

function generate(g) {
  switch (g.kind) {
    case "random": return randomBytes(g.seed, g.len);
    case "zeros": return Buffer.alloc(g.len);
    // A random block repeated: periodic data, cuts recur.
    case "repeat": {
      const block = randomBytes(g.seed, g.block);
      const out = Buffer.alloc(g.len);
      for (let at = 0; at < g.len; at += g.block) block.copy(out, at, 0, Math.min(g.block, g.len - at));
      return out;
    }
    // The same block again and again, one byte in every `every` changed per
    // copy: no two chunks are equal, yet the file as a whole compresses well.
    case "drift": {
      const block = randomBytes(g.seed, g.block);
      const out = Buffer.alloc(g.len);
      for (let at = 0; at < g.len; at++) {
        const b = block[at % g.block];
        out[at] = at % g.every === 0 ? (b + Math.floor(at / g.block)) & 0xff : b;
      }
      return out;
    }
    // Numbered lines of text: low entropy.
    case "text": {
      const parts = [];
      let n = 0;
      for (let i = 0; n < g.len; i++) {
        const line = `${g.tag ?? "line"} ${i}: the quick brown fox jumps over the lazy dog\n`;
        parts.push(line);
        n += line.length;
      }
      return Buffer.from(parts.join(""), "ascii").subarray(0, g.len);
    }
    // The text itself.
    case "literal": return Buffer.from(g.text, "utf8");
    default: throw new Error(`unknown generator ${g.kind}`);
  }
}

// ---- chunker ------------------------------------------------------------------

const inputs = [
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

function lengthsInSlices(data, slice) {
  const chunker = new ContentChunker();
  const lengths = [];
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

// ---- two releases built by the TypeScript publisher ----------------------------

const buildInfo = (version) => JSON.stringify({ version, channel: "stable", platform: "darwin-arm64" });

const TREE = [
  { path: "Contents", dir: true },
  { path: "Contents/Info.plist", gen: { kind: "text", len: 900 } },
  { path: "Contents/MacOS", dir: true },
  { path: "Contents/MacOS/Eos", gen: { kind: "random", seed: "bin", len: 150_000 }, mode: 0o755 },
  { path: "Contents/Resources", dir: true },
  { path: "Contents/Resources/empty", gen: { kind: "zeros", len: 0 } },
  { path: "Contents/Resources/app.js", gen: { kind: "text", len: 1_200_000 } },
  // Sorts after "z" by UTF-16 code unit, and before U+FF5E: the scanner's order is JavaScript's.
  { path: "Contents/Resources/ünïcode ✓.txt", gen: { kind: "text", len: 40 } },
  { path: "Contents/Resources/\u{1F600}.txt", gen: { kind: "text", len: 10, tag: "astral" } },
  { path: "Contents/Resources/～.txt", gen: { kind: "text", len: 10, tag: "bmp" } },
  { path: "Contents/Resources/current", link: "app.js" },
  // What marks a release build; each release names its own version.
  { path: "Contents/Resources/update.json", gen: { kind: "literal", text: buildInfo("9.0.0") } },
];
// The second release rewrites app.js from top to bottom (a re-minified bundle)
// and changes a few bytes in the middle of the binary (a re-stamped signature).
const SECOND = {
  "Contents/Resources/app.js": { kind: "drift", seed: "app2", block: 60_000, every: 1024, len: 300_000 },
  "Contents/Resources/update.json": { kind: "literal", text: buildInfo("9.0.1") },
};
const SECOND_PATCH = { path: "Contents/MacOS/Eos", at: 75_000, bytes: "re-signed" };

function writeTree(root, second) {
  for (const e of TREE) {
    const abs = path.join(root, e.path);
    if (e.dir) {
      mkdirSync(abs, { recursive: true });
      chmodSync(abs, 0o755);
    } else if (e.link) symlinkSync(e.link, abs);
    else {
      const bytes = generate((second && SECOND[e.path]) || e.gen);
      if (second && SECOND_PATCH.path === e.path) Buffer.from(SECOND_PATCH.bytes).copy(bytes, SECOND_PATCH.at);
      writeFileSync(abs, bytes);
      chmodSync(abs, e.mode ?? 0o644);
    }
  }
}

// A throwaway Ed25519 key from a fixed seed (PKCS#8 = this prefix + the seed),
// so every run signs the same bytes. It signs nothing but these fixtures.
const seed = createHash("sha256").update("eos update fixtures: throwaway signing key").digest();
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const privateKey = pkcs8.toString("base64");
const publicKey = String(createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" }).x);

const work = mkdtempSync(path.join(tmpdir(), "eos-update-vectors-"));
try {
  const out = path.join(work, "out");
  const feed = path.join(out, "feed");
  mkdirSync(feed, { recursive: true });
  writeFileSync(path.join(out, "chunker-vectors.json"), JSON.stringify(vectors, null, 1) + "\n");
  const now = () => new Date("2026-11-11T00:00:00.000Z");

  const app1 = path.join(work, "1");
  mkdirSync(app1);
  writeTree(app1, false);
  const first = await buildRelease({ appRoot: app1, version: "9.0.0", platform: "darwin-arm64", previous: null, outDir: feed, notes: "first\n", signingKey: privateKey, now });
  // The pointer is one file per platform: keep each release's own.
  cpSync(path.join(feed, first.pointerPath), path.join(out, "pointer-9.0.0.json"));

  const app2 = path.join(work, "2");
  mkdirSync(app2);
  writeTree(app2, true);
  const second = await buildRelease({ appRoot: app2, version: "9.0.1", platform: "darwin-arm64", previous: first.manifest, outDir: feed, notes: null, signingKey: privateKey, now });
  cpSync(path.join(feed, second.pointerPath), path.join(out, "pointer-9.0.1.json"));
  rmSync(path.join(feed, "stable"), { recursive: true });

  for (const v of ["9.0.0", "9.0.1"]) {
    const zst = readFileSync(path.join(feed, `releases/${v}/darwin-arm64.manifest.json.zst`));
    writeFileSync(path.join(out, `manifest-${v}.json`), zstdDecompressSync(zst));
  }
  writeFileSync(path.join(out, "release.json"), JSON.stringify({
    publicKey,
    privateKey,
    releasedAt: now().toISOString(),
    tree: TREE,
    second: SECOND,
    secondPatch: SECOND_PATCH,
    built: {
      "9.0.0": { files: first.files, packBytes: first.packBytes, newChunks: first.newChunks, wholeFiles: first.wholeFiles },
      "9.0.1": { files: second.files, packBytes: second.packBytes, newChunks: second.newChunks, wholeFiles: second.wholeFiles },
    },
  }, null, 1) + "\n");
  if (second.wholeFiles < 1) throw new Error("the second release should take a file whole");

  const listing = (dir, rel = "") => readdirSync(path.join(dir, rel)).sort().flatMap((name) => {
    const at = rel ? `${rel}/${name}` : name;
    return statSync(path.join(dir, at)).isDirectory() ? listing(dir, at) : [at];
  });
  const files = listing(out);
  if (process.argv.includes("--check")) {
    const stale = files.filter((f) => !existsSync(path.join(OUT, f)) || !readFileSync(path.join(OUT, f)).equals(readFileSync(path.join(out, f))));
    const extra = existsSync(OUT) ? listing(OUT).filter((f) => !files.includes(f)) : [];
    if (stale.length || extra.length) {
      console.error(`rust/fixtures/update is out of date: ${[...stale, ...extra].join(", ")}`);
      process.exit(1);
    }
    console.log(`rust/fixtures/update is current (${files.length} files)`);
  } else {
    rmSync(OUT, { recursive: true, force: true });
    cpSync(out, OUT, { recursive: true });
    console.log(`wrote ${files.length} files: ${vectors.length} chunker vectors; 9.0.0 ${first.manifest.chunks.length} chunks, 9.0.1 ${second.newChunks} new, ${second.wholeFiles} whole`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
