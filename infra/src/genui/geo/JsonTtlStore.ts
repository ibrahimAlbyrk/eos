// A small persistent key → value cache with per-entry expiry, kept in one JSON
// file (geocoder and place-search answers). Bounded by entry count: the oldest
// written go first. Writes are coalesced and atomic (tmp + rename); a corrupt
// or missing file starts empty.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Clock } from "../../../../core/src/ports/Clock.ts";

interface Entry<V> {
  v: V;
  exp: number;
}

export class JsonTtlStore<V> {
  private readonly file: string;
  private readonly clock: Clock;
  private readonly maxEntries: number;
  private entries: Map<string, Entry<V>> | null = null;
  private writing: Promise<void> | null = null;
  private dirty = false;

  constructor(opts: { file: string; clock: Clock; maxEntries?: number }) {
    this.file = opts.file;
    this.clock = opts.clock;
    this.maxEntries = opts.maxEntries ?? 2000;
  }

  get(key: string): V | undefined {
    const map = this.load();
    const e = map.get(key);
    if (!e) return undefined;
    if (e.exp <= this.clock.now()) {
      map.delete(key);
      this.schedule();
      return undefined;
    }
    return e.v;
  }

  set(key: string, value: V, ttlMs: number): void {
    const map = this.load();
    map.delete(key);
    map.set(key, { v: value, exp: this.clock.now() + ttlMs });
    while (map.size > this.maxEntries) map.delete(map.keys().next().value as string);
    this.schedule();
  }

  // Resolves once everything set so far is on disk.
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private load(): Map<string, Entry<V>> {
    if (this.entries) return this.entries;
    const map = new Map<string, Entry<V>>();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const now = this.clock.now();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, raw] of Object.entries(parsed as Record<string, unknown>)) {
          const e = raw as Partial<Entry<V>> | null;
          if (e && typeof e.exp === "number" && e.exp > now && "v" in e) map.set(k, { v: e.v as V, exp: e.exp });
        }
      }
    } catch {
      // first use, or a damaged file — start empty
    }
    this.entries = map;
    return map;
  }

  private schedule(): void {
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await mkdir(dirname(this.file), { recursive: true });
          const tmp = `${this.file}.${process.pid}.tmp`;
          await writeFile(tmp, JSON.stringify(Object.fromEntries(this.entries ?? [])));
          await rename(tmp, this.file);
        } catch {
          // a cache that can't persist still answers from memory
        }
      }
    })().finally(() => {
      this.writing = null;
    });
  }
}
