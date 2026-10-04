// The user's memories as ~/.eos/profile/memories/<id>.md — YAML frontmatter
// (everything but the text) + the memory text, so each stays readable and
// greppable. Loaded once (the daemon is the only writer); writes are atomic;
// remove() moves the file to .trash/. A file that doesn't parse is skipped.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { UserMemorySchema, type UserMemory } from "../../../contracts/src/profile.ts";
import type { UserMemoryStore } from "../../../core/src/ports/UserMemoryStore.ts";
import { moveToTrash, writeFileAtomic } from "./atomic-file.ts";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.ts";

export class FileUserMemoryStore implements UserMemoryStore {
  private readonly dir: string;
  private readonly memories = new Map<string, UserMemory>();

  constructor(dir: string) {
    this.dir = dir;
    this.load();
  }

  list(): UserMemory[] {
    return [...this.memories.values()];
  }

  get(id: string): UserMemory | null {
    return this.memories.get(id) ?? null;
  }

  put(memory: UserMemory): void {
    const parsed = UserMemorySchema.parse(memory);
    writeFileAtomic(join(this.dir, `${parsed.id}.md`), serializeUserMemory(parsed));
    this.memories.set(parsed.id, parsed);
  }

  remove(id: string): boolean {
    if (!this.memories.has(id)) return false;
    moveToTrash(this.dir, UserMemorySchema.shape.id.parse(id), "md");
    this.memories.delete(id);
    return true;
  }

  private load(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const m = parseUserMemory(readFileSync(join(this.dir, file), "utf8"));
        if (m && `${m.id}.md` === file) this.memories.set(m.id, m);
      } catch {
        // unreadable — skip
      }
    }
  }
}

export function serializeUserMemory(m: UserMemory): string {
  const { text, ...meta } = m;
  return joinFrontmatter(meta, `${text}\n`);
}

export function parseUserMemory(raw: string): UserMemory | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const r = UserMemorySchema.safeParse({ ...split.meta, text: split.body });
  return r.success ? r.data : null;
}
