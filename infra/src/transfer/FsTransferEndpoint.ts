// This Mac's disk as a file-transfer endpoint: the engine uses it in-process, and
// /transfer/* serves it to a paired Mac. Incoming bytes go to a staging folder
// inside the destination (`<dest>/.eos-incoming/<id>/files/…`, same volume, so
// placing them is a rename) and only reach their final names at commit.
//
// What it refuses: relative or escaping paths, a destination inside Eos's own
// data, writing through a symlink (links are created last, at commit), more
// bytes than a file was scanned with, and a source that changed since its scan.

import { constants, realpathSync } from "node:fs";
import {
  chmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, statfs, symlink, truncate, utimes, writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  TRANSFER_MAX_CHUNK, TRANSFER_MAX_ITEMS,
  type ManifestItem, type ManifestItemType, type TransferCommitRequest, type TransferCommitResult, type TransferExisting,
  type TransferListEntry, type TransferListing, type TransferManifest, type TransferPrepareRequest, type TransferPrepareResult,
} from "../../../contracts/src/transfer.ts";
import type { TransferEndpoint } from "../../../core/src/ports/TransferEndpoint.ts";
import { TransferError, formatBytes, keepBothName, manifestRoots, relSegments } from "../../../core/src/domain/transfer.ts";

export const STAGING_DIR = ".eos-incoming";
// A commit's answer is kept a while, so a retry after a lost response is a no-op.
const COMMIT_MEMORY_MS = 10 * 60_000;

export interface FsTransferEndpointDeps {
  readonly home: string;
  // Where nothing may land — Eos's own data.
  readonly forbidden: readonly string[];
  readonly trash: (path: string) => Promise<void>;
  readonly projects: {
    toKey(path: string): Promise<string>;
    findPath(key: string): Promise<string | null>;
  };
  readonly now?: () => number;
}

interface Session {
  readonly destDir: string;
  readonly stage: string;
  readonly filesRoot: string;
  readonly items: ManifestItem[];
  readonly files: Map<string, ManifestItem>;
}

export class FsTransferEndpoint implements TransferEndpoint {
  private readonly deps: FsTransferEndpointDeps;
  private readonly now: () => number;
  // Each forbidden root as written and as it really is (/var → /private/var).
  private readonly forbidden: readonly string[];
  private readonly sessions = new Map<string, Session>();
  private readonly committed = new Map<string, { at: number; result: TransferCommitResult }>();

  constructor(deps: FsTransferEndpointDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.forbidden = [...new Set(deps.forbidden.flatMap((f) => [resolve(f), realOr(f)]))];
  }

  async home(): Promise<string> {
    return this.deps.home;
  }

  async list(dir: string, opts?: { hidden?: boolean }): Promise<TransferListing> {
    const abs = absolute(dir);
    const st = await stat(abs).catch(() => { throw new TransferError("not-found", `${abs} doesn't exist`); });
    if (!st.isDirectory()) throw new TransferError("bad-path", `${abs} is not a folder`);
    const names = (await readdir(abs)).filter((n) => n !== ".DS_Store" && n !== STAGING_DIR && (opts?.hidden || !n.startsWith(".")));
    const entries = (await Promise.all(names.map((name) => listEntry(abs, name)))).filter((e): e is TransferListEntry => e !== null);
    entries.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
    return { path: abs, parent: abs === "/" ? null : dirname(abs), home: this.deps.home, entries };
  }

  async scan(paths: readonly string[]): Promise<TransferManifest> {
    const items: ManifestItem[] = [];
    const names = new Set<string>();
    for (const p of paths) {
      const abs = absolute(p);
      const name = basename(abs);
      if (names.has(name)) throw new TransferError("duplicate-name", `two picked items are both called "${name}" — send them one at a time`);
      names.add(name);
      const st = await lstat(abs).catch(() => { throw new TransferError("not-found", `${abs} doesn't exist`); });
      await walk(abs, name, st, items);
    }
    const files = items.filter((i) => i.type === "file");
    return {
      roots: manifestRoots(items),
      items,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      fileCount: files.length,
    };
  }

  async read(path: string, range: { offset: number; length: number }, expect: { size: number; mtimeMs: number }): Promise<Uint8Array> {
    const abs = absolute(path);
    if (!Number.isInteger(range.offset) || !Number.isInteger(range.length) || range.offset < 0 || range.length < 1
      || range.length > TRANSFER_MAX_CHUNK || range.offset + range.length > expect.size) {
      throw new TransferError("bad-path", "that range is outside the file");
    }
    const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
      throw new TransferError("source-changed", `${basename(abs)} is gone or was replaced since it was picked`);
    });
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size !== expect.size || Math.trunc(st.mtimeMs) !== Math.trunc(expect.mtimeMs)) {
        throw new TransferError("source-changed", `${basename(abs)} changed while it was being copied — send it again`);
      }
      const buf = Buffer.allocUnsafe(range.length);
      let got = 0;
      while (got < range.length) {
        const { bytesRead } = await fh.read(buf, got, range.length - got, range.offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    } finally {
      await fh.close();
    }
  }

  async prepare(req: TransferPrepareRequest): Promise<TransferPrepareResult> {
    const destDir = await this.destination(req.destDir, true);
    const items = validItems(req.items);
    const stage = join(destDir, STAGING_DIR, req.id);
    const filesRoot = join(stage, "files");
    await mkdir(filesRoot, { recursive: true });
    // A file staged against another version of itself (it changed since a pause) starts over.
    const before = new Map((await readManifest(stage)).map((i) => [i.rel, i]));
    for (const it of items) if (it.type === "dir") await mkdir(join(filesRoot, it.rel), { recursive: true });
    const staged: Record<string, number> = {};
    for (const it of items) {
      if (it.type !== "file") continue;
      const p = join(filesRoot, it.rel);
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      const prev = before.get(it.rel);
      const same = prev?.type === "file" && prev.size === it.size && Math.trunc(prev.mtimeMs) === Math.trunc(it.mtimeMs);
      if (!st.isFile() || !same || st.size > it.size) {
        if (st.isFile()) await truncate(p, 0);
        else await rm(p, { recursive: true, force: true });
        continue;
      }
      if (st.size > 0) staged[it.rel] = st.size;
    }
    await writeFile(join(stage, "manifest.json"), JSON.stringify(items));
    this.sessions.set(req.id, session(destDir, stage, items));

    const existing: TransferExisting[] = [];
    for (const it of items) {
      if (it.rel.includes("/")) continue;
      const st = await lstat(join(destDir, it.rel)).catch(() => null);
      if (st) existing.push({ name: it.rel, type: itemType(st), size: st.isFile() ? st.size : null, mtimeMs: st.mtimeMs });
    }
    const fs = await statfs(destDir);
    const freeBytes = fs.bavail * fs.bsize;
    const need = items.reduce((n, i) => n + (i.type === "file" ? i.size - (staged[i.rel] ?? 0) : 0), 0);
    if (need > freeBytes) throw new TransferError("no-space", `needs ${formatBytes(need)} but only ${formatBytes(freeBytes)} is free`);
    return { existing, staged, freeBytes };
  }

  async write(at: { id: string; destDir: string; rel: string; offset: number }, data: Uint8Array): Promise<number> {
    const s = await this.session(at.id, at.destDir);
    const item = s.files.get(at.rel);
    if (!item) throw new TransferError("bad-path", `${at.rel} isn't part of this transfer`);
    if (at.offset + data.byteLength > item.size) throw new TransferError("bad-path", `more bytes than ${at.rel} has`);
    const p = join(s.filesRoot, at.rel);
    await assertInside(s.filesRoot, dirname(p));
    const fh = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const size = (await fh.stat()).size;
      if (size !== at.offset) throw new TransferError("offset-mismatch", `${at.rel} holds ${size} bytes, not ${at.offset}`, size);
      let off = 0;
      while (off < data.byteLength) {
        const { bytesWritten } = await fh.write(data, off, data.byteLength - off, at.offset + off);
        off += bytesWritten;
      }
      return at.offset + data.byteLength;
    } finally {
      await fh.close();
    }
  }

  async commit(req: TransferCommitRequest): Promise<TransferCommitResult> {
    this.forgetOldCommits();
    const done = this.committed.get(req.id);
    if (done) return done.result;
    const s = await this.session(req.id, req.destDir);
    const roots = s.items.filter((i) => !i.rel.includes("/"));
    // A retry after a commit that stopped half-way: what already moved stays
    // moved. Each root's outcome is recorded as it lands (name; null = skipped).
    const progressPath = join(s.stage, "placed.json");
    const progress = await readProgress(progressPath);
    const inPending = (rel: string): boolean => !progress.has(rel.split("/", 1)[0]!);

    for (const it of s.items) {
      if (it.type !== "file" || !inPending(it.rel)) continue;
      const p = join(s.filesRoot, it.rel);
      const st = await lstat(p).catch(() => null);
      if (!st && it.size === 0) {
        await assertInside(s.filesRoot, dirname(p));
        await (await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)).close();
        continue;
      }
      if (!st?.isFile() || st.size !== it.size) throw new TransferError("incomplete", `${it.rel} isn't fully copied yet`);
    }
    // Links last, so nothing was ever written through one.
    for (const it of s.items) {
      if (it.type !== "link" || !inPending(it.rel)) continue;
      const p = join(s.filesRoot, it.rel);
      if (!(await lstat(p).catch(() => null))) await symlink(it.target ?? "", p);
    }
    // Deepest first: setting a folder's time before its children would undo it.
    const byDepth = s.items.filter((i) => i.type !== "link" && inPending(i.rel)).sort((a, b) => depth(b.rel) - depth(a.rel));
    for (const it of byDepth) {
      const p = join(s.filesRoot, it.rel);
      // A folder stays enterable and removable by its owner, whatever it was.
      await chmod(p, it.type === "dir" ? it.mode | 0o700 : it.mode);
      const t = it.mtimeMs / 1000;
      await utimes(p, t, t);
    }

    // Asked of the disk, not a listing: on a case-insensitive volume "Readme.md"
    // is already there when "README.md" is, and a rename would silently replace it.
    const taken = new Set((await readdir(s.destDir)).map((n) => n.toLowerCase()));
    for (const r of roots) {
      if (progress.has(r.rel)) continue;
      const there = (await lstat(join(s.destDir, r.rel)).catch(() => null)) !== null;
      const decision = there ? req.decisions[r.rel] : undefined;
      if (there && !decision) throw new TransferError("conflict-unresolved", `"${r.rel}" is already there`);
      let name: string | null = null;
      if (decision !== "skip") {
        if (decision === "replace") await this.deps.trash(join(s.destDir, r.rel));
        name = decision === "keep" ? keepBothName(r.rel, (n) => taken.has(n.toLowerCase())) : r.rel;
        await rename(join(s.filesRoot, r.rel), join(s.destDir, name));
        taken.add(name.toLowerCase());
      }
      progress.set(r.rel, name);
      await writeFile(progressPath, JSON.stringify([...progress]));
    }
    await this.dropStage(s.destDir, s.stage);
    this.sessions.delete(req.id);
    // Reported under the folder as the caller named it, not its resolved path.
    const shown = resolve(req.destDir);
    const result: TransferCommitResult = {
      placed: [...progress.values()].filter((n): n is string => n !== null).map((name) => ({ name, path: join(shown, name) })),
      skipped: [...progress].filter(([, n]) => n === null).map(([root]) => root),
    };
    this.committed.set(req.id, { at: this.now(), result });
    return result;
  }

  async abort(req: { id: string; destDir: string }): Promise<void> {
    const destDir = await this.destination(req.destDir, false).catch(() => null);
    this.sessions.delete(req.id);
    if (destDir) await this.dropStage(destDir, join(destDir, STAGING_DIR, req.id));
  }

  async projectKey(dir: string): Promise<string | null> {
    const key = await this.deps.projects.toKey(absolute(dir));
    return key.startsWith("git:") ? key : null;
  }

  async locate(key: string): Promise<string | null> {
    return key.startsWith("git:") ? this.deps.projects.findPath(key) : null;
  }

  // The destination as it really is on disk, outside Eos's own data.
  private async destination(dir: string, create: boolean): Promise<string> {
    const abs = absolute(dir);
    this.assertAllowed(abs);
    if (create) await mkdir(abs, { recursive: true }).catch(() => { throw new TransferError("bad-path", `can't create ${abs}`); });
    const real = await realpath(abs).catch(() => { throw new TransferError("not-found", `${abs} doesn't exist`); });
    this.assertAllowed(real);
    if (!(await stat(real)).isDirectory()) throw new TransferError("bad-path", `${abs} is not a folder`);
    return real;
  }

  private assertAllowed(path: string): void {
    for (const f of this.forbidden) {
      const rel = relative(f, path);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new TransferError("forbidden-dest", "files can't be put inside Eos's own data folder");
    }
  }

  // The staging a prepare set up — reloaded from disk after a daemon restart.
  private async session(id: string, destDir: string): Promise<Session> {
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const real = await this.destination(destDir, false);
    const stage = join(real, STAGING_DIR, id);
    const items = await readManifest(stage);
    if (!items.length) throw new TransferError("not-found", "nothing is staged for this transfer");
    const s = session(real, stage, items);
    this.sessions.set(id, s);
    return s;
  }

  private async dropStage(destDir: string, stage: string): Promise<void> {
    await rm(stage, { recursive: true, force: true });
    await rmdir(join(destDir, STAGING_DIR)).catch(() => {});
  }

  private forgetOldCommits(): void {
    const cutoff = this.now() - COMMIT_MEMORY_MS;
    for (const [id, c] of this.committed) if (c.at < cutoff) this.committed.delete(id);
  }
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function session(destDir: string, stage: string, items: ManifestItem[]): Session {
  return {
    destDir, stage, filesRoot: join(stage, "files"), items,
    files: new Map(items.filter((i) => i.type === "file").map((i) => [i.rel, i])),
  };
}

function absolute(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new TransferError("bad-path", "an absolute path is required");
  return resolve(p);
}

function validItems(items: readonly ManifestItem[]): ManifestItem[] {
  if (items.length > TRANSFER_MAX_ITEMS) throw new TransferError("too-many", "too many files in one transfer — zip them first");
  const seen = new Set<string>();
  for (const it of items) {
    if (!relSegments(it.rel)) throw new TransferError("bad-path", `"${it.rel}" isn't a safe path`);
    if (seen.has(it.rel)) throw new TransferError("bad-path", `"${it.rel}" appears twice`);
    seen.add(it.rel);
    if (it.type === "link" && it.target === undefined) throw new TransferError("bad-path", `link "${it.rel}" has no target`);
  }
  return [...items];
}

async function readProgress(path: string): Promise<Map<string, string | null>> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    return new Map(Array.isArray(raw) ? (raw as Array<[string, string | null]>) : []);
  } catch {
    return new Map();
  }
}

async function readManifest(stage: string): Promise<ManifestItem[]> {
  try {
    const raw = JSON.parse(await readFile(join(stage, "manifest.json"), "utf8")) as unknown;
    return Array.isArray(raw) ? validItems(raw as ManifestItem[]) : [];
  } catch {
    return [];
  }
}

// The folder a staged file is written into must really be inside the staging —
// a link left there by an earlier, interrupted commit must not redirect it.
async function assertInside(root: string, dir: string): Promise<void> {
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir).catch(() => null)]);
  if (!realDir) throw new TransferError("bad-path", "that file's folder isn't staged");
  const rel = relative(realRoot, realDir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new TransferError("bad-path", "that path leaves the staging folder");
}

async function walk(abs: string, rel: string, st: Stats, items: ManifestItem[]): Promise<void> {
  if (items.length >= TRANSFER_MAX_ITEMS) throw new TransferError("too-many", `more than ${TRANSFER_MAX_ITEMS.toLocaleString("en-US")} files — zip them first`);
  const mode = st.mode & 0o777;
  if (st.isSymbolicLink()) {
    items.push({ rel, type: "link", size: 0, mtimeMs: st.mtimeMs, mode, target: await readlink(abs) });
    return;
  }
  if (st.isFile()) {
    items.push({ rel, type: "file", size: st.size, mtimeMs: st.mtimeMs, mode });
    return;
  }
  if (!st.isDirectory()) return;
  items.push({ rel, type: "dir", size: 0, mtimeMs: st.mtimeMs, mode });
  const names = (await readdir(abs)).filter((n) => n !== ".DS_Store" && n !== STAGING_DIR).sort();
  for (const n of names) {
    const child = join(abs, n);
    const cst = await lstat(child).catch(() => null);
    if (cst) await walk(child, `${rel}/${n}`, cst, items);
  }
}

async function listEntry(dir: string, name: string): Promise<TransferListEntry | null> {
  const path = join(dir, name);
  const l = await lstat(path).catch(() => null);
  if (!l) return null;
  const target = l.isSymbolicLink() ? (await stat(path).catch(() => null)) ?? l : l;
  const isDir = target.isDirectory();
  if (!isDir && !target.isFile() && !l.isSymbolicLink()) return null;
  return { name, path, type: isDir ? "directory" : "file", isSymlink: l.isSymbolicLink(), size: isDir ? null : target.size, mtimeMs: target.mtimeMs };
}

function itemType(st: Stats): ManifestItemType {
  return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
}

function depth(rel: string): number {
  return rel.split("/").length;
}
