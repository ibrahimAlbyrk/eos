// FileProjectMemoryStore — file-backed ProjectMemoryStore over Claude Code's
// per-project memory directory (~/.claude/projects/<encoded-cwd>/memory). Each
// memory is a markdown file: YAML frontmatter (name/description/metadata.type)
// + body. list() parses that metadata; softDelete moves the file to .trash/
// (recoverable) and writeIndex rewrites MEMORY.md atomically (tmp→rename).
// MEMORY.md and the .trash/ dir are never returned as entries.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ProjectMemoryStore } from "../../../core/src/ports/ProjectMemoryStore.ts";
import type { MemoryEntry, MemoryType } from "../../../contracts/src/http.ts";

const INDEX_FILE = "MEMORY.md";
const NAME_RE = /^[a-z0-9][a-z0-9-_]*$/;
const TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

export class FileProjectMemoryStore implements ProjectMemoryStore {
  async list(dir: string): Promise<MemoryEntry[]> {
    if (!existsSync(dir)) return [];
    const out: MemoryEntry[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || file === INDEX_FILE) continue;
      const name = file.slice(0, -3);
      if (!NAME_RE.test(name)) continue;
      try {
        const path = join(dir, file);
        const { description, type } = parseFrontmatter(readFileSync(path, "utf8"));
        out.push({ name, description, type, path, updatedAt: statSync(path).mtimeMs });
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async softDelete(dir: string, name: string): Promise<boolean> {
    assertName(name);
    const path = join(dir, `${name}.md`);
    if (!existsSync(path)) return false;
    const trash = join(dir, ".trash");
    mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    renameSync(path, join(trash, `${name}.${stamp}.md`));
    return true;
  }

  async readIndex(dir: string): Promise<string> {
    const path = join(dir, INDEX_FILE);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  async writeIndex(dir: string, text: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, INDEX_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  }
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid memory name: ${name}`);
}

function parseRawFrontmatter(raw: string): Record<string, unknown> | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  try {
    const fm = parseYaml(match[1]);
    if (fm && typeof fm === "object") return fm as Record<string, unknown>;
  } catch {}
  return null;
}

function parseFrontmatter(raw: string): { description: string; type: MemoryType } {
  const fm = parseRawFrontmatter(raw);
  let description = "";
  let type: MemoryType = "project";
  if (fm) {
    if (typeof fm.description === "string") description = fm.description;
    const meta = fm.metadata;
    if (meta && typeof meta === "object") {
      const t = (meta as Record<string, unknown>).type;
      if (typeof t === "string" && TYPES.has(t as MemoryType)) type = t as MemoryType;
    }
  }
  return { description, type };
}
