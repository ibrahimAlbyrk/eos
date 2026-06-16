// NodeFileSystem — node:fs/promises implementation of the FileSystem port.
// Listing is stat-free (type from the readdir Dirent) so expanding a folder is
// one syscall regardless of size; only symlinks pay a single follow-stat to
// resolve whether their target is a directory. fs errno is translated to
// domain errors so the route's errorHandler maps 404/409/403 automatically.

import { access, cp, lstat, mkdir as fsMkdir, open, readdir, rename as fsRename, rm, stat as fsStat } from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConflictError, NotFoundError, PermissionDeniedError } from "../../../core/src/errors/index.ts";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";
import type {
  FileSystem,
  FsEntryMeta,
  FsEntryType,
  FsStat,
  ListDirOptions,
  MoveOptions,
} from "../../../core/src/ports/FileSystem.ts";
import { trashIntoDir, trashViaFinder } from "./trashDarwin.ts";

export interface NodeFileSystemDeps {
  trashDir: string; // ~/.eos-trash fallback root
  platform: string; // process.platform
}

function mapFsError(e: unknown, path: string): never {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") throw new NotFoundError("path", path);
  if (code === "EEXIST") throw new ConflictError(`already exists: ${path}`);
  if (code === "EACCES" || code === "EPERM") throw new PermissionDeniedError(`permission denied: ${path}`);
  throw e instanceof Error ? e : new Error(String(e));
}

function compareEntries(a: FsEntryMeta, b: FsEntryMeta): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function createNodeFileSystem(deps: NodeFileSystemDeps): FileSystem {
  const { trashDir, platform } = deps;

  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };

  const canWrite = async (p: string): Promise<boolean> => {
    try {
      await access(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };

  const listDir = async (dir: string, opts: ListDirOptions): Promise<FsEntryMeta[]> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      return mapFsError(e, dir);
    }
    const includeHidden = opts.includeHidden ?? false;
    const applyIgnore = opts.applyIgnore ?? true;
    const kept = dirents.filter(
      (d) => (includeHidden || !d.name.startsWith(".")) && !(applyIgnore && IGNORED_ENTRIES.has(d.name)),
    );
    const out = await Promise.all(
      kept.map(async (d): Promise<FsEntryMeta> => {
        const absolutePath = join(dir, d.name);
        const isSymlink = d.isSymbolicLink();
        let type: FsEntryType;
        if (isSymlink) {
          try {
            const t = await fsStat(absolutePath); // follow once; broken link → "file"
            type = t.isDirectory() ? "directory" : "file";
          } catch {
            type = "file";
          }
        } else {
          type = d.isDirectory() ? "directory" : "file";
        }
        return { name: d.name, absolutePath, relativePath: relative(opts.root, absolutePath), type, isSymlink };
      }),
    );
    out.sort(compareEntries);
    return out;
  };

  const stat = async (path: string): Promise<FsStat> => {
    let s;
    try {
      s = await lstat(path);
    } catch (e) {
      return mapFsError(e, path);
    }
    const isSymlink = s.isSymbolicLink();
    let type: FsEntryType = s.isDirectory() ? "directory" : "file";
    let size = s.size;
    let mtimeMs = s.mtimeMs;
    if (isSymlink) {
      try {
        const t = await fsStat(path);
        type = t.isDirectory() ? "directory" : "file";
        size = t.size;
        mtimeMs = t.mtimeMs;
      } catch {
        type = "file";
      }
    }
    return { absolutePath: path, type, size, mtimeMs, isSymlink, readonly: !(await canWrite(path)) };
  };

  const createFile = async (path: string, content = ""): Promise<void> => {
    let fh: FileHandle;
    try {
      fh = await open(path, "wx"); // O_CREAT | O_EXCL — collision → EEXIST
    } catch (e) {
      return mapFsError(e, path);
    }
    try {
      if (content) await fh.writeFile(content, "utf8");
    } finally {
      await fh.close();
    }
  };

  const mkdir = async (path: string): Promise<void> => {
    try {
      await fsMkdir(path); // non-recursive: missing parent → ENOENT, exists → EEXIST
    } catch (e) {
      mapFsError(e, path);
    }
  };

  const rename = async (from: string, to: string): Promise<void> => {
    if (await exists(to)) throw new ConflictError(`already exists: ${to}`);
    try {
      await fsRename(from, to);
    } catch (e) {
      mapFsError(e, from);
    }
  };

  const move = async (from: string, to: string, opts?: MoveOptions): Promise<void> => {
    if (!opts?.overwrite && (await exists(to))) throw new ConflictError(`already exists: ${to}`);
    try {
      await fsRename(from, to);
    } catch (e) {
      if ((e as { code?: string })?.code === "EXDEV") {
        await cp(from, to, { recursive: true, force: !!opts?.overwrite });
        await rm(from, { recursive: true, force: true });
        return;
      }
      mapFsError(e, from);
    }
  };

  const trash = async (path: string): Promise<void> => {
    if (platform === "darwin") {
      try {
        await trashViaFinder(path);
        return;
      } catch {
        // Finder automation may be denied/unavailable; fall back to the
        // daemon-owned trash dir so delete still works and stays reversible.
        await trashIntoDir(path, trashDir);
        return;
      }
    }
    await trashIntoDir(path, trashDir);
  };

  return { listDir, stat, createFile, mkdir, rename, move, trash, exists };
}
