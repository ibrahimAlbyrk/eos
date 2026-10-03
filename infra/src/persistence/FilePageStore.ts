// FilePageStore — pages as markdown files under ~/.eos/pages/<id>.md: YAML
// frontmatter (everything but the body) + the markdown body, so a page stays
// readable and survives a state.db wipe. Loaded once into memory (the daemon is
// the only writer); writes are atomic tmp → rename; remove() moves the file to
// .trash/ so a deleted page is recoverable by hand.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { PageSchema, type Page } from "../../../contracts/src/http.ts";
import type { PageStore } from "../../../core/src/ports/PageStore.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export class FilePageStore implements PageStore {
  private readonly dir: string;
  private readonly pages = new Map<string, Page>();

  constructor(dir: string) {
    this.dir = dir;
    this.load();
  }

  list(): Page[] {
    return [...this.pages.values()];
  }

  get(id: string): Page | null {
    return this.pages.get(id) ?? null;
  }

  put(page: Page): void {
    const parsed = PageSchema.parse(page);
    mkdirSync(this.dir, { recursive: true });
    const path = this.fileOf(parsed.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializePage(parsed));
    renameSync(tmp, path);
    this.pages.set(parsed.id, parsed);
  }

  remove(id: string): boolean {
    if (!this.pages.has(id)) return false;
    const path = this.fileOf(id);
    if (existsSync(path)) {
      const trash = join(this.dir, ".trash");
      mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      renameSync(path, join(trash, `${id}.${stamp}.md`));
    }
    this.pages.delete(id);
    return true;
  }

  private fileOf(id: string): string {
    return join(this.dir, `${PageSchema.shape.id.parse(id)}.md`);
  }

  // A file that doesn't parse is skipped, never fatal — one bad page must not
  // hide the rest.
  private load(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const page = parsePage(readFileSync(join(this.dir, file), "utf8"));
        if (page && `${page.id}.md` === file) this.pages.set(page.id, page);
      } catch {
        // unreadable — skip
      }
    }
  }
}

export function serializePage(page: Page): string {
  const { body, ...meta } = page;
  return `---\n${stringifyYaml(meta).trimEnd()}\n---\n${body}`;
}

export function parsePage(raw: string): Page | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  const meta: unknown = parseYaml(m[1]!);
  if (!meta || typeof meta !== "object") return null;
  const r = PageSchema.safeParse({ ...meta, body: raw.slice(m[0].length) });
  return r.success ? r.data : null;
}
