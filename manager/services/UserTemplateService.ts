// UserTemplateService — CRUD store for user prompt templates under
// ~/.eos/templates/, one markdown file per template (YAML frontmatter
// with `description` + `attachments`, body = prompt content). Same format as
// manager/prompts/ so files stay hand-editable; re-read on every call, no cache.
// Deletes are soft: the file moves to templates/.trash/<name>.<stamp>.md
// so a wrong click (or a misbehaving agent) is recoverable by hand.
//
// Attachments are reference files/images the template carries. They are copied
// into a durable per-template store (templates/assets/<name>/) on write so a
// template authored today still resolves weeks later — composer paste paths live
// in OS temp and would be garbage-collected. Stored paths are RELATIVE to the
// templates dir (portable across home moves/backups); read() resolves them back
// to absolute. Folder references are kept as-is (not copied).

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join, basename, resolve, relative, isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { Template, TemplateAttachment } from "../../contracts/src/http.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class UserTemplateService {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
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
    const { description, attachments, body } = splitFrontmatter(raw);
    return {
      name,
      description,
      content: body.trim(),
      attachments: this.resolveAttachments(attachments),
    };
  }

  exists(name: string): boolean {
    assertName(name);
    return existsSync(join(this.dir, `${name}.md`));
  }

  write(template: Template): void {
    assertName(template.name);
    mkdirSync(this.dir, { recursive: true });
    const attachments = this.promoteAttachments(template.name, template.attachments ?? []);
    const fm: Record<string, unknown> = { description: template.description };
    if (attachments.length) fm.attachments = attachments;
    const frontmatter = stringifyYaml(fm).trimEnd();
    const file = `---\n${frontmatter}\n---\n\n${template.content.trim()}\n`;
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
    const trash = join(this.dir, ".trash");
    mkdirSync(trash, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
    renameSync(path, join(trash, `${name}.${stamp}.md`));
    const assetDir = this.assetDir(name);
    if (existsSync(assetDir)) {
      const trashAssets = join(trash, "assets");
      mkdirSync(trashAssets, { recursive: true });
      renameSync(assetDir, join(trashAssets, `${name}.${stamp}`));
    }
    return true;
  }

  private assetDir(name: string): string {
    return join(this.dir, "assets", name);
  }

  // Resolve stored attachment paths back to absolute: relative entries point into
  // the asset store, absolute entries (folder references) pass through unchanged.
  private resolveAttachments(stored: TemplateAttachment[]): TemplateAttachment[] {
    return stored.map((a) => ({
      ...a,
      path: isAbsolute(a.path) ? a.path : join(this.dir, a.path),
    }));
  }

  // Copy non-folder attachment files into the durable asset store and return the
  // attachments with storage paths: relative (assets/<name>/<file>) for promoted
  // files, the absolute path unchanged for folder references. Files already inside
  // the template's own asset dir are kept as-is (idempotent re-save); a source
  // that vanished is dropped rather than crashing the save.
  private promoteAttachments(name: string, attachments: TemplateAttachment[]): TemplateAttachment[] {
    const assetDir = this.assetDir(name);
    const out: TemplateAttachment[] = [];
    for (const att of attachments) {
      if (att.kind === "folder") {
        out.push(att);
        continue;
      }
      const abs = isAbsolute(att.path) ? att.path : join(this.dir, att.path);
      if (!existsSync(abs)) continue;
      if (isInside(assetDir, abs)) {
        out.push({ ...att, path: relative(this.dir, abs) });
        continue;
      }
      mkdirSync(assetDir, { recursive: true });
      const dest = uniqueDest(assetDir, basename(abs).replace(/[/\0]/g, "_"));
      copyFileSync(abs, dest);
      out.push({ ...att, path: relative(this.dir, dest) });
    }
    return out;
  }
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid template name: ${name}`);
}

function isInside(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function uniqueDest(dir: string, filename: string): string {
  if (!existsSync(join(dir, filename))) return join(dir, filename);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let n = 2; ; n++) {
    const dest = join(dir, `${stem}-${n}${ext}`);
    if (!existsSync(dest)) return dest;
  }
}

function splitFrontmatter(raw: string): {
  description: string;
  attachments: TemplateAttachment[];
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { description: "", attachments: [], body: raw };
  let description = "";
  let attachments: TemplateAttachment[] = [];
  try {
    const fm = parseYaml(match[1]);
    if (fm && typeof fm === "object") {
      const rec = fm as Record<string, unknown>;
      if (typeof rec.description === "string") description = rec.description;
      if (Array.isArray(rec.attachments)) attachments = parseAttachments(rec.attachments);
    }
  } catch {}
  return { description, attachments, body: raw.slice(match[0].length) };
}

function parseAttachments(raw: unknown[]): TemplateAttachment[] {
  const out: TemplateAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.label !== "string" || typeof r.path !== "string") continue;
    if (r.kind !== "image" && r.kind !== "file" && r.kind !== "folder") continue;
    out.push({ label: r.label, kind: r.kind, path: r.path });
  }
  return out;
}
