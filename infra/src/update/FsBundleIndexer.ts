// What the installed bundle already holds, for planning an update: each file by
// its content hash and each chunk by its id, with where its bytes sit.

import type { BundleIndex, LocalChunk } from "../../../core/src/domain/update/plan.ts";
import type { BundleIndexer } from "../../../core/src/ports/Updates.ts";
import { scanBundle } from "./bundleScan.ts";

export class FsBundleIndexer implements BundleIndexer {
  async index(root: string): Promise<BundleIndex> {
    const files = new Map<string, string>();
    const chunks = new Map<string, LocalChunk>();
    for (const entry of await scanBundle(root, { chunks: true })) {
      if (entry.type !== "file") continue;
      if (!files.has(entry.sha256)) files.set(entry.sha256, entry.path);
      for (const c of entry.chunks) {
        if (!chunks.has(c.id)) chunks.set(c.id, { path: entry.path, offset: c.offset, size: c.size });
      }
    }
    return { files, chunks };
  }
}
