// A manifest arrives signed, yet its shape is checked again before a byte is
// written: every path stays inside the bundle, a link can neither point out of
// it nor be walked through, and chunk references are in range and add up.

import type { UpdateManifest } from "../../../../contracts/src/update.ts";
import { relSegments } from "../transfer.ts";
import { CHUNK_MAX } from "./chunker.ts";

export function manifestProblem(manifest: UpdateManifest): string | null {
  const { packs, chunks, entries } = manifest;
  for (const c of chunks) {
    if (c.pack >= packs.length) return `chunk ${c.id} names pack ${c.pack}`;
    if (c.size > CHUNK_MAX) return `chunk ${c.id} is larger than any chunk can be`;
  }

  const paths = new Set<string>();
  const links = new Set<string>();
  for (const e of entries) {
    const segments = relSegments(e.path);
    if (!segments) return `unsafe path ${JSON.stringify(e.path)}`;
    if (paths.has(e.path)) return `${e.path} is listed twice`;
    paths.add(e.path);
    if (e.type === "link") {
      if (!linkStaysInside(segments, e.target)) return `${e.path} links outside the bundle`;
      links.add(e.path);
    }
    if (e.type === "file") {
      let sum = 0;
      for (const i of e.chunks) {
        const c = chunks[i];
        if (!c) return `${e.path} names chunk ${i}`;
        sum += c.size;
      }
      if (sum !== e.size) return `${e.path}: its chunks add up to ${sum} bytes, not ${e.size}`;
      if (e.whole && e.whole.pack >= packs.length) return `${e.path} names pack ${e.whole.pack}`;
    }
  }

  // Writing under a link would write wherever the link points.
  for (const e of entries) {
    const segments = e.path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (links.has(ancestor)) return `${e.path} lies under the link ${ancestor}`;
    }
  }
  return null;
}

// A link's target, resolved from the folder the link sits in, stays inside the bundle.
export function linkStaysInside(linkSegments: readonly string[], target: string): boolean {
  if (!target || target.startsWith("/") || target.includes("\0")) return false;
  const resolved = linkSegments.slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") resolved.push(part);
    else if (resolved.pop() === undefined) return false;
  }
  return true;
}
