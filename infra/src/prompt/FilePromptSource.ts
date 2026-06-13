// FilePromptSource — reads *.prompt.md files from one or more directories and
// parses their YAML frontmatter. Later directories override earlier ones by id
// (user prompts shadow built-ins). Reads fresh on every list() so edits apply
// without a daemon restart — matching the old PromptTemplateService behavior.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RawPrompt } from "../../../core/src/domain/prompt.ts";
import type { PromptSource } from "../../../core/src/ports/PromptSource.ts";

const EXT = ".prompt.md";

export class FilePromptSource implements PromptSource {
  private readonly dirs: string[];

  constructor(dirs: string[]) {
    this.dirs = dirs;
  }

  list(): RawPrompt[] {
    const byId = new Map<string, RawPrompt>();
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        try {
          const raw = readPrompt(dir, file);
          byId.set(raw.id, raw);
        } catch {
          // One unreadable file must not break the whole catalog (G5). It simply
          // won't appear; `eos prompts validate` surfaces it at authoring time.
        }
      }
    }
    return [...byId.values()];
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(EXT)) out.push(full);
  }
  return out;
}

function readPrompt(dir: string, file: string): RawPrompt {
  const content = readFileSync(file, "utf8");
  const { frontmatter, body } = splitFrontmatter(content);
  let fm: unknown = {};
  if (frontmatter) {
    // Malformed YAML → empty frontmatter, body still usable. Locals passed at
    // render time work regardless of whether `variables:` parsed.
    try {
      fm = parseYaml(frontmatter) ?? {};
    } catch {
      fm = {};
    }
  }
  const pathId = relative(dir, file).slice(0, -EXT.length).split(sep).join("/");
  const declaredId =
    fm && typeof fm === "object" && typeof (fm as { id?: unknown }).id === "string"
      ? (fm as { id: string }).id
      : pathId;
  return { id: declaredId, frontmatter: fm, body, sourcePath: file };
}

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}
