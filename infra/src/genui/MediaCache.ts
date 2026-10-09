// Disk cache for visual-answer media: ~/.eos/media-cache/<sha256>.{json,bin}.
// Regenerable (not user data). Entries expire after a TTL; the cache as a whole
// is held under a byte cap by evicting the least recently used first. Last use
// is the data file's mtime (touched on every hit), so LRU order survives a
// daemon restart without a separate index file.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Clock } from "../../../core/src/ports/Clock.ts";

export const MEDIA_CACHE_MAX_BYTES = 500 * 1024 * 1024;
export const MEDIA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A failure is remembered briefly so a broken image isn't refetched on every render.
export const MEDIA_CACHE_MISS_TTL_MS = 60 * 60 * 1000;

// "blob" = bytes; "ref" = a resolved URL (og:image, icon); "miss" = a failure, kept briefly.
export type CacheKind = "blob" | "ref" | "miss";

export interface CacheMeta {
  url: string;
  kind: CacheKind;
  contentType: string;
  size: number;
  fetchedAt: number;
  ref?: string | null;
  reason?: string;
}

export interface CacheHit {
  meta: CacheMeta;
  body: Buffer | null;
}

interface IndexEntry {
  size: number;
  lastUsed: number;
}

const KEY_RE = /^[0-9a-f]{64}$/;

export function cacheKey(namespace: string, url: string): string {
  return createHash("sha256").update(`${namespace}\n${url}`).digest("hex");
}

export class MediaCache {
  private readonly dir: string;
  private readonly clock: Clock;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly missTtlMs: number;
  private index = new Map<string, IndexEntry>();
  private total = 0;
  private loading: Promise<void> | null = null;

  constructor(opts: { dir: string; clock: Clock; maxBytes?: number; ttlMs?: number; missTtlMs?: number }) {
    this.dir = opts.dir;
    this.clock = opts.clock;
    this.maxBytes = opts.maxBytes ?? MEDIA_CACHE_MAX_BYTES;
    this.ttlMs = opts.ttlMs ?? MEDIA_CACHE_TTL_MS;
    this.missTtlMs = opts.missTtlMs ?? MEDIA_CACHE_MISS_TTL_MS;
  }

  get totalBytes(): number {
    return this.total;
  }

  async get(key: string): Promise<CacheHit | null> {
    await this.load();
    if (!KEY_RE.test(key) || !this.index.has(key)) return null;
    let meta: CacheMeta;
    try {
      meta = JSON.parse(await readFile(this.metaPath(key), "utf8")) as CacheMeta;
    } catch {
      await this.drop(key);
      return null;
    }
    const ttl = meta.kind === "miss" ? this.missTtlMs : this.ttlMs;
    if (this.clock.now() - meta.fetchedAt > ttl) {
      await this.drop(key);
      return null;
    }
    let body: Buffer | null = null;
    if (meta.kind === "blob") {
      try {
        body = await readFile(this.blobPath(key));
      } catch {
        await this.drop(key);
        return null;
      }
    }
    this.touch(key);
    return { meta, body };
  }

  async put(key: string, meta: CacheMeta, body: Buffer | null = null): Promise<void> {
    if (!KEY_RE.test(key)) return;
    await this.load();
    await mkdir(this.dir, { recursive: true });
    const metaJson = JSON.stringify({ ...meta, size: body?.length ?? 0 });
    const size = (body?.length ?? 0) + Buffer.byteLength(metaJson);
    if (size > this.maxBytes) return;
    const stamp = `${process.pid}-${this.clock.now()}-${Math.random().toString(36).slice(2)}`;
    if (body) {
      const tmp = `${this.blobPath(key)}.${stamp}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.blobPath(key));
    } else {
      await rm(this.blobPath(key), { force: true });
    }
    const tmpMeta = `${this.metaPath(key)}.${stamp}.tmp`;
    await writeFile(tmpMeta, metaJson);
    await rename(tmpMeta, this.metaPath(key));
    const prev = this.index.get(key);
    if (prev) this.total -= prev.size;
    this.index.set(key, { size, lastUsed: this.clock.now() });
    this.total += size;
    await this.evict();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    await this.drop(key);
  }

  private metaPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private blobPath(key: string): string {
    return join(this.dir, `${key}.bin`);
  }

  private touch(key: string): void {
    const entry = this.index.get(key);
    if (!entry) return;
    const now = this.clock.now();
    entry.lastUsed = now;
    const t = new Date(now);
    void utimes(this.metaPath(key), t, t).catch(() => {});
  }

  private async drop(key: string): Promise<void> {
    const entry = this.index.get(key);
    if (entry) {
      this.total -= entry.size;
      this.index.delete(key);
    }
    await Promise.all([rm(this.metaPath(key), { force: true }), rm(this.blobPath(key), { force: true })]);
  }

  private async evict(): Promise<void> {
    if (this.total <= this.maxBytes) return;
    const order = [...this.index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key] of order) {
      if (this.total <= this.maxBytes) break;
      await this.drop(key);
    }
  }

  private load(): Promise<void> {
    this.loading ??= this.scan();
    return this.loading;
  }

  // One pass over the directory at first use: sizes + last use from the files.
  private async scan(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const sizes = new Map<string, number>();
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        await rm(join(this.dir, name), { force: true });
        continue;
      }
      const m = /^([0-9a-f]{64})\.(json|bin)$/.exec(name);
      if (!m) continue;
      try {
        const st = await stat(join(this.dir, name));
        sizes.set(m[1], (sizes.get(m[1]) ?? 0) + st.size);
        if (m[2] === "json") this.index.set(m[1], { size: 0, lastUsed: st.mtimeMs });
      } catch {
        // vanished mid-scan
      }
    }
    for (const [key, entry] of this.index) {
      entry.size = sizes.get(key) ?? 0;
      this.total += entry.size;
    }
    // A data file without its meta is an interrupted write.
    for (const key of sizes.keys()) {
      if (!this.index.has(key)) await rm(this.blobPath(key), { force: true });
    }
    await this.evict();
  }
}
