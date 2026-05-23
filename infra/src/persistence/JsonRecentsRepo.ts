// JsonRecentsRepo — file-backed recent-folders list. Stored as a JSON array
// of absolute paths, most-recent-first, deduped, capped at MAX_ENTRIES.
// Atomic write via tmp + rename so a daemon crash mid-write never leaves a
// truncated file.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RecentsRepo } from "../../../core/src/ports/RecentsRepo.ts";

const MAX_ENTRIES = 20;

export class JsonRecentsRepo implements RecentsRepo {
  private readonly file: string;
  private cache: string[];

  constructor(file: string) {
    this.file = file;
    this.cache = this.read();
  }

  list(): string[] {
    return [...this.cache];
  }

  push(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    const next = [trimmed, ...this.cache.filter((p) => p !== trimmed)].slice(0, MAX_ENTRIES);
    this.cache = next;
    this.write(next);
  }

  private read(): string[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private write(paths: string[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(paths));
      renameSync(tmp, this.file);
    } catch {
      // best-effort; recents are non-critical
    }
  }
}
