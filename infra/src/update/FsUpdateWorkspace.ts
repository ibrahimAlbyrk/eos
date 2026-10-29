// ~/.eos/updates — regenerable. Fetched ranges live under downloads/<version>/
// (checked chunk by chunk before they are kept); the new bundle is built under
// staged/<version>/ on the same volume as the installed app, so unchanged files
// are APFS clones (instant, no extra disk) and the final swap is a rename;
// staged.json says which version is ready.
//
// Building a bundle never touches the installed one, and the result is scanned
// again and compared with the manifest entry by entry before it counts.

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod, copyFile, mkdir, open, readdir, readFile, rename, rm, stat, symlink, writeFile, type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";

import {
  UPDATE_FILES, UpdateNoticeSchema,
  type PackSpan, type UpdateEntry, type UpdateFileEntry, type UpdateManifest, type UpdateNotice,
} from "../../../contracts/src/update.ts";
import { CHUNK_MAX } from "../../../core/src/domain/update/chunker.ts";
import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import { chunksWithin, type FetchRange, type FilePart, type FileStep, type UpdatePlan } from "../../../core/src/domain/update/plan.ts";
import type { StagedUpdate, UpdateWorkspace } from "../../../core/src/ports/Updates.ts";
import { scanBundle, type ScannedEntry } from "./bundleScan.ts";

const COPY_SLICE = 4 * 1024 * 1024;
const LAST_VERSION = "last-version";

export class FsUpdateWorkspace implements UpdateWorkspace {
  readonly dir: string;
  // Whether files keep permission bits here (not on Windows).
  private readonly fileModes: boolean;

  constructor(dir: string, opts: { fileModes?: boolean } = {}) {
    this.dir = dir;
    this.fileModes = opts.fileModes ?? true;
  }

  async hasRange(version: string, range: FetchRange): Promise<boolean> {
    const st = await stat(this.rangePath(version, range)).catch(() => null);
    return st?.size === range.length;
  }

  async putRange(version: string, range: FetchRange, bytes: Uint8Array, manifest: UpdateManifest): Promise<void> {
    for (const i of chunksWithin(manifest, range)) {
      const c = manifest.chunks[i];
      const frame = bytes.subarray(c.offset - range.offset, c.offset - range.offset + c.zsize);
      if (!chunkMatches(frame, c.id, c.size)) throw new UpdateError("corrupt", `chunk ${c.id.slice(0, 12)} came down damaged`);
    }
    const path = this.rangePath(version, range);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
  }

  async stage(input: { version: string; manifest: UpdateManifest; plan: UpdatePlan; installedRoot: string }): Promise<string> {
    const { version, manifest, plan, installedRoot } = input;
    const base = await this.stagingBase(version, installedRoot);
    const root = join(base, basename(installedRoot));
    await rm(base, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    const steps = new Map(plan.files.map((s) => [s.path, s]));
    const frames = new FrameReader(this, version, plan.ranges, manifest);
    try {
      for (const entry of manifest.entries) {
        const dst = join(root, entry.path);
        if (entry.type === "dir") await mkdir(dst, { recursive: true });
        else if (entry.type === "file") await this.writeFile(entry, steps.get(entry.path), dst, installedRoot, frames);
      }
      for (const entry of manifest.entries) {
        if (entry.type === "link") await symlink(entry.target, join(root, entry.path));
      }
      if (this.fileModes) {
        for (const entry of [...manifest.entries].reverse()) {
          if (entry.type === "dir") await chmod(join(root, entry.path), entry.mode);
        }
        await chmod(root, 0o755);
      }
    } catch (e) {
      if (e instanceof UpdateError) throw e;
      throw new UpdateError("disk", `building the new version failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await frames.close();
    }

    const problem = treeMismatch(manifest.entries, await scanBundle(root, { chunks: false }), { modes: this.fileModes });
    if (problem) throw new UpdateError("corrupt", `the new version does not match its manifest: ${problem}`);
    return root;
  }

  async staged(): Promise<StagedUpdate | null> {
    try {
      const record = JSON.parse(await readFile(this.stagedRecord, "utf8")) as StagedUpdate;
      return (await stat(record.path).catch(() => null))?.isDirectory() ? record : null;
    } catch {
      return null;
    }
  }

  async markStaged(update: StagedUpdate): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(`${this.stagedRecord}.tmp`, JSON.stringify(update));
    await rename(`${this.stagedRecord}.tmp`, this.stagedRecord);
  }

  async clear(keep?: string): Promise<void> {
    await rm(this.stagedRecord, { force: true });
    await rm(join(this.dir, "staged"), { recursive: true, force: true });
    const downloads = join(this.dir, "downloads");
    if (!keep) {
      await rm(downloads, { recursive: true, force: true });
      return;
    }
    for (const name of await readdir(downloads).catch(() => [] as string[])) {
      if (name !== keep) await rm(join(downloads, name), { recursive: true, force: true });
    }
  }

  // The version that ran here last — a newer one now means it was updated.
  async lastVersion(): Promise<string | null> {
    return (await readFile(join(this.dir, LAST_VERSION), "utf8").catch(() => "")).trim() || null;
  }

  async setLastVersion(version: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, LAST_VERSION), version);
  }

  // How the applier's last swap ended, as it left it in result.json.
  async result(): Promise<{ notice: UpdateNotice; dismissed: boolean } | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, UPDATE_FILES.result), "utf8")) as Record<string, unknown>;
      const notice = UpdateNoticeSchema.safeParse(raw);
      return notice.success ? { notice: notice.data, dismissed: raw.dismissed === true } : null;
    } catch {
      return null;
    }
  }

  // Kept, so a version that failed to start isn't fetched again on its own.
  async dismissResult(): Promise<void> {
    const current = await this.result();
    if (!current) return;
    const path = join(this.dir, UPDATE_FILES.result);
    await writeFile(`${path}.tmp`, JSON.stringify({ ...current.notice, dismissed: true }));
    await rename(`${path}.tmp`, path);
  }

  rangePath(version: string, range: FetchRange): string {
    return join(this.dir, "downloads", version, `${range.pack}-${range.offset}-${range.length}.zst`);
  }

  private get stagedRecord(): string {
    return join(this.dir, "staged.json");
  }

  // Clones and the final rename need the installed app's volume.
  private async stagingBase(version: string, installedRoot: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const [here, app] = await Promise.all([stat(this.dir), stat(dirname(installedRoot))]);
    return here.dev === app.dev ? join(this.dir, "staged", version) : join(dirname(installedRoot), `.eos-update-${version}`);
  }

  private async writeFile(
    entry: UpdateFileEntry, step: FileStep | undefined, dst: string, installedRoot: string, frames: FrameReader,
  ): Promise<void> {
    if (!step) throw new UpdateError("bad-release", `${entry.path} has no plan`);
    if (step.kind === "copy") {
      await copyFile(join(installedRoot, step.source), dst, constants.COPYFILE_FICLONE);
    } else {
      const hash = createHash("sha256");
      let size = 0;
      const out = await open(dst, "w");
      try {
        const write = async (bytes: Uint8Array): Promise<void> => {
          hash.update(bytes);
          size += bytes.length;
          await out.write(bytes);
        };
        if (step.kind === "whole") await frames.streamWhole(step.span, write);
        else for (const part of step.parts) await writePart(part, installedRoot, frames, write);
      } finally {
        await out.close();
      }
      if (size !== entry.size || hash.digest("hex") !== entry.sha256) {
        throw new UpdateError("corrupt", `${entry.path} did not come out as the release has it`);
      }
    }
    if (this.fileModes) await chmod(dst, entry.mode);
  }
}

async function writePart(
  part: FilePart, installedRoot: string, frames: FrameReader, write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  if (part.from === "pack") {
    await write(await frames.chunk(part.chunk));
    return;
  }
  const src = await open(join(installedRoot, part.path), "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(COPY_SLICE, part.size));
    for (let done = 0; done < part.size;) {
      const want = Math.min(buf.length, part.size - done);
      const { bytesRead } = await src.read(buf, 0, want, part.offset + done);
      if (bytesRead === 0) throw new UpdateError("disk", `${part.path} is shorter than when it was indexed`);
      await write(buf.subarray(0, bytesRead));
      done += bytesRead;
    }
  } finally {
    await src.close();
  }
}

// Reads frames out of the fetched ranges that hold them.
class FrameReader {
  private readonly workspace: FsUpdateWorkspace;
  private readonly version: string;
  private readonly ranges: readonly FetchRange[];
  private readonly manifest: UpdateManifest;
  private readonly handles = new Map<string, Promise<FileHandle>>();

  constructor(workspace: FsUpdateWorkspace, version: string, ranges: readonly FetchRange[], manifest: UpdateManifest) {
    this.workspace = workspace;
    this.version = version;
    this.ranges = ranges;
    this.manifest = manifest;
  }

  async chunk(index: number): Promise<Uint8Array> {
    const c = this.manifest.chunks[index];
    const { path, at } = this.locate(c);
    const handle = await this.handle(path);
    const frame = Buffer.allocUnsafe(c.zsize);
    const { bytesRead } = await handle.read(frame, 0, c.zsize, at);
    if (bytesRead !== c.zsize) throw new UpdateError("corrupt", `a fetched range is shorter than its chunks`);
    return zstdDecompressSync(frame, { maxOutputLength: CHUNK_MAX });
  }

  async streamWhole(span: PackSpan, write: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    const { path, at } = this.locate(span);
    const sink = new Transform({
      transform(part: Buffer, _enc, done) {
        write(part).then(() => done(), done);
      },
    });
    try {
      await pipeline(createReadStream(path, { start: at, end: at + span.zsize - 1 }), createZstdDecompress(), sink);
    } catch (e) {
      if (e instanceof UpdateError) throw e;
      throw new UpdateError("corrupt", "a whole-file frame does not unpack");
    }
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) await (await h).close().catch(() => {});
    this.handles.clear();
  }

  private locate(span: PackSpan): { path: string; at: number } {
    const range = this.ranges.find((r) => r.pack === span.pack && span.offset >= r.offset && span.offset + span.zsize <= r.offset + r.length);
    if (!range) throw new UpdateError("corrupt", "a needed chunk was never fetched");
    return { path: this.workspace.rangePath(this.version, range), at: span.offset - range.offset };
  }

  private handle(path: string): Promise<FileHandle> {
    let h = this.handles.get(path);
    if (!h) {
      h = open(path, "r");
      this.handles.set(path, h);
    }
    return h;
  }
}

function chunkMatches(frame: Uint8Array, id: string, size: number): boolean {
  try {
    const bytes = zstdDecompressSync(frame, { maxOutputLength: CHUNK_MAX });
    return bytes.length === size && createHash("sha256").update(bytes).digest("hex") === id;
  } catch {
    return false;
  }
}

// The first way a built tree differs from what the manifest lists, if any.
export function treeMismatch(
  expected: readonly UpdateEntry[], actual: readonly ScannedEntry[], opts: { modes: boolean } = { modes: true },
): string | null {
  if (expected.length !== actual.length) return `${actual.length} entries instead of ${expected.length}`;
  const built = new Map(actual.map((a) => [a.path, a]));
  for (const w of expected) {
    const a = built.get(w.path);
    if (!a || a.type !== w.type) return `${w.path} is missing`;
    if (w.type === "link" && a.type === "link" && w.target !== a.target) return `${w.path} links elsewhere`;
    if (opts.modes && w.type === "dir" && a.type === "dir" && w.mode !== a.mode) return `${w.path} has mode ${a.mode.toString(8)}`;
    if (w.type === "file" && a.type === "file" && ((opts.modes && w.mode !== a.mode) || w.size !== a.size || w.sha256 !== a.sha256)) {
      return `${w.path} differs`;
    }
  }
  return null;
}
