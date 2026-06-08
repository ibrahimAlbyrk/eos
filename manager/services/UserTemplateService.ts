// UserTemplateService — CRUD store for user prompt templates under
// ~/.eos/templates/, one markdown file per template (YAML frontmatter
// with `description`, body = prompt content). Same format as manager/prompts/
// so files stay hand-editable; re-read on every call, no cache.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { Template } from "../../contracts/src/http.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class UserTemplateService {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  list(): Template[] {
    if (!existsSync(this.dir)) return [];
    const out: Template[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        out.push(this.read(file.slice(0, -3)));
      } catch {}
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name: string): Template {
    assertName(name);
    const raw = readFileSync(join(this.dir, `${name}.md`), "utf8");
    const { description, body } = splitFrontmatter(raw);
    return { name, description, content: body.trim() };
  }

  exists(name: string): boolean {
    assertName(name);
    return existsSync(join(this.dir, `${name}.md`));
  }

  write(template: Template): void {
    assertName(template.name);
    mkdirSync(this.dir, { recursive: true });
    const fm = stringifyYaml({ description: template.description }).trimEnd();
    const file = `---\n${fm}\n---\n\n${template.content.trim()}\n`;
    const path = join(this.dir, `${template.name}.md`);
    // atomic: write tmp, rename over target
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, file);
    renameSync(tmp, path);
  }

  delete(name: string): boolean {
    assertName(name);
    const path = join(this.dir, `${name}.md`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid template name: ${name}`);
}

function splitFrontmatter(raw: string): { description: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { description: "", body: raw };
  let description = "";
  try {
    const fm = parseYaml(match[1]);
    if (fm && typeof fm === "object" && typeof (fm as Record<string, unknown>).description === "string") {
      description = (fm as Record<string, unknown>).description as string;
    }
  } catch {}
  return { description, body: raw.slice(match[0].length) };
}
