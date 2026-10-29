// What an update costs, decided before a byte moves: which files are already
// installed as they are, which are rebuilt from chunks on disk plus downloaded
// ones, and the few byte ranges to fetch from the packs. Pure: the indexer says
// what is on disk, the manifest says what should be.

import type { PackSpan, UpdateManifest } from "../../../../contracts/src/update.ts";

export interface LocalChunk {
  path: string;
  offset: number;
  size: number;
}

export interface BundleIndex {
  // sha256 of an installed file → its path in the bundle
  files: ReadonlyMap<string, string>;
  // chunk id → where its bytes already are
  chunks: ReadonlyMap<string, LocalChunk>;
}

export type FilePart =
  | { from: "disk"; path: string; offset: number; size: number }
  | { from: "pack"; chunk: number };

export type FileStep =
  | { kind: "copy"; path: string; source: string }
  | { kind: "assemble"; path: string; parts: FilePart[] }
  | { kind: "whole"; path: string; span: PackSpan };

export interface FetchRange {
  pack: number;
  offset: number;
  length: number;
}

export interface UpdatePlan {
  files: FileStep[];
  ranges: FetchRange[];
  downloadBytes: number;
  reusedBytes: number;
}

// Bridging a gap this small costs less than another request.
export const RANGE_MAX_GAP = 64 * 1024;
// A request stays small enough to retry cheaply.
export const RANGE_MAX_LENGTH = 16 * 1024 * 1024;

export function planUpdate(index: BundleIndex, manifest: UpdateManifest): UpdatePlan {
  const files: FileStep[] = [];
  const spans: PackSpan[] = [];
  const queued = new Set<number>();
  let reusedBytes = 0;

  for (const entry of manifest.entries) {
    if (entry.type !== "file") continue;
    const installed = index.files.get(entry.sha256);
    if (installed !== undefined) {
      files.push({ kind: "copy", path: entry.path, source: installed });
      reusedBytes += entry.size;
      continue;
    }

    const parts: FilePart[] = [];
    const missing = new Set<number>();
    let missingCost = 0;
    let fromDisk = 0;
    for (const i of entry.chunks) {
      const chunk = manifest.chunks[i];
      const local = index.chunks.get(chunk.id);
      if (local) {
        pushDiskPart(parts, local);
        fromDisk += chunk.size;
        continue;
      }
      parts.push({ from: "pack", chunk: i });
      if (!queued.has(i) && !missing.has(i)) {
        missing.add(i);
        missingCost += chunk.zsize;
      }
    }

    if (entry.whole && entry.whole.zsize < missingCost) {
      files.push({ kind: "whole", path: entry.path, span: entry.whole });
      spans.push(entry.whole);
      continue;
    }
    for (const i of missing) {
      queued.add(i);
      spans.push(manifest.chunks[i]);
    }
    files.push({ kind: "assemble", path: entry.path, parts });
    reusedBytes += fromDisk;
  }

  const ranges = coalesceSpans(spans);
  return { files, ranges, downloadBytes: ranges.reduce((n, r) => n + r.length, 0), reusedBytes };
}

// Consecutive chunks of one installed file read as one part.
function pushDiskPart(parts: FilePart[], local: LocalChunk): void {
  const last = parts[parts.length - 1];
  if (last?.from === "disk" && last.path === local.path && last.offset + last.size === local.offset) {
    last.size += local.size;
    return;
  }
  parts.push({ from: "disk", path: local.path, offset: local.offset, size: local.size });
}

// The chunks whose frames lie wholly inside a fetched range (indexes into
// manifest.chunks) — what its bytes can be checked against.
export function chunksWithin(manifest: UpdateManifest, range: FetchRange): number[] {
  const end = range.offset + range.length;
  const inside: number[] = [];
  manifest.chunks.forEach((c, i) => {
    if (c.pack === range.pack && c.offset >= range.offset && c.offset + c.zsize <= end) inside.push(i);
  });
  return inside;
}

export function coalesceSpans(spans: readonly PackSpan[]): FetchRange[] {
  const sorted = [...spans].sort((a, b) => a.pack - b.pack || a.offset - b.offset);
  const ranges: FetchRange[] = [];
  for (const span of sorted) {
    const last = ranges[ranges.length - 1];
    const end = span.offset + span.zsize;
    if (last && last.pack === span.pack
      && span.offset - (last.offset + last.length) <= RANGE_MAX_GAP
      && end - last.offset <= RANGE_MAX_LENGTH) {
      last.length = Math.max(last.length, end - last.offset);
      continue;
    }
    ranges.push({ pack: span.pack, offset: span.offset, length: span.zsize });
  }
  return ranges;
}
