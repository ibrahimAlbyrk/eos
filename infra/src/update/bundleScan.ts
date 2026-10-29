// Reads an app bundle the way the update feed describes it: every directory,
// link and file in path order, each file hashed whole and — when asked — cut
// into content-defined chunks with their own hashes. The publisher builds a
// release's manifest from it; the installed app indexes itself with it; a
// staged copy is checked with it. One reader, so all three see the same tree.

import { createHash, type Hash } from "node:crypto";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { ContentChunker } from "../../../core/src/domain/update/chunker.ts";

const READ_SLICE = 4 * 1024 * 1024;

export interface ScannedChunk {
  id: string;
  offset: number;
  size: number;
}

export type ScannedEntry =
  | { type: "dir"; path: string; mode: number }
  | { type: "link"; path: string; target: string }
  | { type: "file"; path: string; mode: number; size: number; sha256: string; chunks: ScannedChunk[] };

export async function scanBundle(root: string, opts: { chunks: boolean }): Promise<ScannedEntry[]> {
  const entries: ScannedEntry[] = [];
  await walk(root, "", entries, opts.chunks);
  return entries;
}

async function walk(root: string, rel: string, out: ScannedEntry[], chunks: boolean): Promise<void> {
  const names = (await readdir(join(root, rel))).sort();
  for (const name of names) {
    const path = rel ? `${rel}/${name}` : name;
    const abs = join(root, path);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) out.push({ type: "link", path, target: await readlink(abs) });
    else if (st.isDirectory()) {
      out.push({ type: "dir", path, mode: st.mode & 0o777 });
      await walk(root, path, out, chunks);
    } else if (st.isFile()) out.push({ type: "file", path, mode: st.mode & 0o777, ...(await readFile(abs, chunks)) });
    else throw new Error(`${path}: not a file, folder or link`);
  }
}

async function readFile(abs: string, withChunks: boolean): Promise<{ size: number; sha256: string; chunks: ScannedChunk[] }> {
  const whole = createHash("sha256");
  const chunks: ScannedChunk[] = [];
  const chunker = new ContentChunker();
  let piece: Hash = createHash("sha256");
  // Bytes of the chunk in progress already fed to `piece` from earlier slices.
  let pending = 0;
  let offset = 0;
  let size = 0;
  const close = (length: number): void => {
    chunks.push({ id: piece.digest("hex"), offset, size: length });
    offset += length;
    piece = createHash("sha256");
  };

  const handle = await open(abs, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_SLICE);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, READ_SLICE, null);
      if (bytesRead === 0) break;
      const slice = buf.subarray(0, bytesRead);
      size += bytesRead;
      whole.update(slice);
      if (!withChunks) continue;
      let at = 0;
      for (const length of chunker.push(slice)) {
        piece.update(slice.subarray(at, at + length - pending));
        at += length - pending;
        pending = 0;
        close(length);
      }
      piece.update(slice.subarray(at));
      pending += slice.length - at;
    }
  } finally {
    await handle.close();
  }
  if (withChunks) {
    const last = chunker.end();
    if (last !== null) close(last);
  }
  return { size, sha256: whole.digest("hex"), chunks };
}
