// Turns a built app bundle into a release on the feed: its manifest, one pack
// holding only the chunks the previous release didn't have, and the signed
// pointer. Everything lands under `outDir` in the feed's own layout, so
// publishing is a plain upload of that tree (pointer last).

import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants as zc, zstdCompressSync } from "node:zlib";

import {
  UPDATE_MANIFEST_FORMAT, UpdateManifestSchema,
  type PackSpan, type UpdateChunk, type UpdateEntry, type UpdateFileEntry, type UpdateManifest, type UpdatePlatform, type UpdatePointer,
} from "../../../contracts/src/update.ts";
import { manifestProblem } from "../../../core/src/domain/update/manifest.ts";
import { scanBundle } from "./bundleScan.ts";
import { signUpdatePayload } from "./ed25519.ts";

// Every install downloads a release's new chunks, so they get zstd's best. A
// platform's first pack is the whole bundle, which installs already hold and
// almost never fetch — a quick level keeps that publish to seconds.
const DEFAULT_LEVEL = 19;
const FIRST_PACK_LEVEL = 9;
// A changed file is weighed whole only when its new chunks cost more than this
// and make up most of it — a binary whose signature alone changed never wins,
// and compressing hundreds of MB to find that out costs minutes.
const WHOLE_MIN_COST = 64 * 1024;
const WHOLE_MIN_SHARE = 0.5;
// …and taken whole only when that saves a tenth or more.
const WHOLE_GAIN = 0.9;

export interface BuildReleaseInput {
  readonly appRoot: string;
  readonly version: string;
  readonly platform: UpdatePlatform;
  // The release users update from; null for the first one on the feed.
  readonly previous: UpdateManifest | null;
  readonly outDir: string;
  readonly notes: string | null;
  readonly signingKey: string;
  readonly now: () => Date;
  // zstd level, when not the default for this release.
  readonly level?: number;
}

export interface BuiltRelease {
  readonly manifest: UpdateManifest;
  // Feed paths written under outDir, the pointer last.
  readonly files: string[];
  readonly pointerPath: string;
  readonly packBytes: number;
  readonly newChunks: number;
  readonly wholeFiles: number;
}

export async function buildRelease(input: BuildReleaseInput): Promise<BuiltRelease> {
  const { version, platform, previous, outDir } = input;
  const packPath = `packs/${platform}/${version}.pack`;
  const scanned = await scanBundle(input.appRoot, { chunks: true });

  // Chunks the feed already holds, by id, with the pack that has them.
  const known = new Map<string, { chunk: UpdateChunk; pack: string }>();
  for (const c of previous?.chunks ?? []) known.set(c.id, { chunk: c, pack: previous!.packs[c.pack] });
  const previousFiles = new Set(previous?.entries.flatMap((e) => (e.type === "file" ? [e.sha256] : [])) ?? []);

  const level = input.level ?? (previous ? DEFAULT_LEVEL : FIRST_PACK_LEVEL);
  const compress = (bytes: Buffer): Buffer => zstdCompressSync(bytes, { params: { [zc.ZSTD_c_compressionLevel]: level } });
  const pack = new PackWriter(join(outDir, packPath), compress);
  const packs: string[] = [];
  const packIndex = (path: string): number => {
    let i = packs.indexOf(path);
    if (i < 0) i = packs.push(path) - 1;
    return i;
  };
  const chunks: UpdateChunk[] = [];
  const chunkIndex = new Map<string, number>();
  const entries: UpdateEntry[] = [];
  let newChunks = 0;
  let wholeFiles = 0;

  try {
    for (const e of scanned) {
      if (e.type !== "file") {
        entries.push(e);
        continue;
      }
      const file = await open(join(input.appRoot, e.path), "r");
      try {
        const ids: number[] = [];
        let addedCost = 0;
        let totalCost = 0;
        for (const c of e.chunks) {
          let i = chunkIndex.get(c.id);
          if (i === undefined) {
            const old = known.get(c.id);
            let span: PackSpan;
            if (old) span = { ...old.chunk, pack: packIndex(old.pack) };
            else {
              span = { ...(await pack.append(await readAt(file, c.offset, c.size))), pack: packIndex(packPath) };
              addedCost += span.zsize;
              newChunks++;
            }
            i = chunks.push({ id: c.id, size: c.size, pack: span.pack, offset: span.offset, zsize: span.zsize }) - 1;
            chunkIndex.set(c.id, i);
          }
          totalCost += chunks[i].zsize;
          ids.push(i);
        }
        const entry: UpdateFileEntry = { type: "file", path: e.path, mode: e.mode, size: e.size, sha256: e.sha256, chunks: ids };
        if (previous && !previousFiles.has(e.sha256) && addedCost > WHOLE_MIN_COST && addedCost >= totalCost * WHOLE_MIN_SHARE) {
          const whole = compress(await readAt(file, 0, e.size));
          if (whole.length < addedCost * WHOLE_GAIN) {
            entry.whole = { ...(await pack.appendFrame(whole)), pack: packIndex(packPath) };
            wholeFiles++;
          }
        }
        entries.push(entry);
      } finally {
        await file.close();
      }
    }
  } finally {
    await pack.close();
  }

  const manifest = UpdateManifestSchema.parse({ format: UPDATE_MANIFEST_FORMAT, version, platform, packs, chunks, entries });
  const problem = manifestProblem(manifest);
  if (problem) throw new Error(`the built manifest is unsound: ${problem}`);

  const files: string[] = [];
  if (pack.size > 0) files.push(packPath);
  const manifestPath = `releases/${version}/${platform}.manifest.json.zst`;
  const packed = compress(Buffer.from(JSON.stringify(manifest)));
  await put(outDir, manifestPath, packed);
  files.push(manifestPath);

  let notesPath: string | undefined;
  if (input.notes) {
    notesPath = `notes/${version}.md`;
    await put(outDir, notesPath, Buffer.from(input.notes));
    files.push(notesPath);
  }

  const pointer: UpdatePointer = {
    version,
    platform,
    manifest: { path: manifestPath, sha256: createHash("sha256").update(packed).digest("hex"), size: packed.length },
    ...(notesPath ? { notes: notesPath } : {}),
    releasedAt: input.now().toISOString(),
  };
  const payload = JSON.stringify(pointer);
  const pointerPath = `stable/${platform}.json`;
  await put(outDir, pointerPath, Buffer.from(JSON.stringify({ payload, signature: signUpdatePayload(payload, input.signingKey) })));
  files.push(pointerPath);

  return { manifest, files, pointerPath, packBytes: pack.size, newChunks, wholeFiles };
}

async function readAt(file: Awaited<ReturnType<typeof open>>, offset: number, size: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(size);
  const { bytesRead } = await file.read(buf, 0, size, offset);
  if (bytesRead !== size) throw new Error("a file changed while the release was being built");
  return buf;
}

async function put(outDir: string, path: string, bytes: Buffer): Promise<void> {
  const abs = join(outDir, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

// Appends zstd frames to the release's pack; opened only once a frame comes.
class PackWriter {
  private readonly path: string;
  private readonly compress: (bytes: Buffer) => Buffer;
  private file: Awaited<ReturnType<typeof open>> | null = null;
  size = 0;

  constructor(path: string, compress: (bytes: Buffer) => Buffer) {
    this.path = path;
    this.compress = compress;
  }

  append(bytes: Buffer): Promise<{ offset: number; zsize: number }> {
    return this.appendFrame(this.compress(bytes));
  }

  async appendFrame(frame: Buffer): Promise<{ offset: number; zsize: number }> {
    if (!this.file) {
      await mkdir(dirname(this.path), { recursive: true });
      this.file = await open(this.path, "w");
    }
    const offset = this.size;
    await this.file.write(frame, 0, frame.length, offset);
    this.size += frame.length;
    return { offset, zsize: frame.length };
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = null;
  }
}

