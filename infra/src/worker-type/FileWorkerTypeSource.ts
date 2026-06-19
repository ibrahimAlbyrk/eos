// FileWorkerTypeSource — reads .eos/workers/*.md files (YAML frontmatter +
// markdown body) from one or more directories and validates each against
// WorkerTypeSchema. Later directories override earlier ones by NAME (project
// shadows user shadows built-in). Reads fresh on every list() so edits apply
// without a daemon restart. Clone of FilePromptSource.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  WorkerTypeSchema,
  type WorkerTypeRecord,
  type WorkerTypeSource as WorkerTypeProvenance,
} from "../../../contracts/src/worker-type.ts";
import type { WorkerTypeSource } from "../../../core/src/ports/WorkerTypeSource.ts";

const EXT = ".md";

export interface WorkerTypeDir {
  dir: string;
  source: WorkerTypeProvenance;
}

export class FileWorkerTypeSource implements WorkerTypeSource {
  private readonly dirs: WorkerTypeDir[];

  constructor(dirs: WorkerTypeDir[]) {
    this.dirs = dirs;
  }

  list(): WorkerTypeRecord[] {
    const byName = new Map<string, WorkerTypeRecord>();
    for (const { dir, source } of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const rec = readType(file, source);
        // One unreadable/invalid file must not break the whole catalog: it
        // simply won't appear (a type with no `name` fails validation → skip).
        if (rec) byName.set(rec.name, rec);
      }
    }
    return [...byName.values()];
  }
}

// Nearest .eos/workers on the walk-up from the spawn cwd to the filesystem root
// (Claude Code recursive-scan rule: nearest project dir wins). null if none.
export function findProjectWorkerTypesDir(startCwd: string): string | null {
  let dir = resolve(startCwd);
  for (;;) {
    const candidate = join(dir, ".eos", "workers");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
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

function readType(file: string, source: WorkerTypeProvenance): WorkerTypeRecord | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { frontmatter, body } = splitFrontmatter(content);
  let fm: Record<string, unknown> = {};
  if (frontmatter) {
    try {
      const parsed = parseYaml(frontmatter);
      if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const result = WorkerTypeSchema.safeParse({ ...fm, body });
  if (!result.success) return null;
  return { ...result.data, source };
}

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}
