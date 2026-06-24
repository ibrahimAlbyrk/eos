// FileWorkflowDefinitionSource — reads ~/.eos/workflows/* definition files from
// one or more directories and validates each against WorkflowDefinitionSchema.
// Later directories override earlier ones by NAME (project shadows user shadows
// built-in). Reads fresh on every list() so edits apply without a daemon restart.
// Clone of FileWorkerDefinitionSource.
//
// A workflow definition is a structured tree (root/experts/argsSchema) with no
// natural prose "body", so the primary on-disk form is `.json` (the whole file IS
// the definition JSON). A `.md` form is accepted for parity with the worker-def
// convention: its YAML frontmatter holds the definition and the markdown body is
// folded in as `description` when the frontmatter omits one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionSource as WorkflowDefinitionProvenance,
} from "../../../contracts/src/workflow.ts";
import type { WorkflowDefinitionSource } from "../../../core/src/ports/WorkflowDefinitionSource.ts";

const JSON_EXT = ".json";
const MD_EXT = ".md";

export interface WorkflowDefinitionDir {
  dir: string;
  source: WorkflowDefinitionProvenance;
}

export class FileWorkflowDefinitionSource implements WorkflowDefinitionSource {
  private readonly dirs: WorkflowDefinitionDir[];

  constructor(dirs: WorkflowDefinitionDir[]) {
    this.dirs = dirs;
  }

  list(): WorkflowDefinitionRecord[] {
    const byName = new Map<string, WorkflowDefinitionRecord>();
    for (const { dir, source } of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const rec = readDefinition(file, source);
        // One unreadable/invalid file must not break the whole catalog: it
        // simply won't appear (a definition with no `name`/`root` fails → skip).
        if (rec) byName.set(rec.name, rec);
      }
    }
    return [...byName.values()];
  }
}

// Nearest .eos/workflows on the walk-up from the spawn cwd to the filesystem root
// (nearest project dir wins). null if none.
export function findProjectWorkflowDefinitionsDir(startCwd: string): string | null {
  let dir = resolve(startCwd);
  for (;;) {
    const candidate = join(dir, ".eos", "workflows");
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
    else if (entry.isFile() && (entry.name.endsWith(JSON_EXT) || entry.name.endsWith(MD_EXT))) out.push(full);
  }
  return out;
}

function readDefinition(file: string, source: WorkflowDefinitionProvenance): WorkflowDefinitionRecord | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const candidate = file.endsWith(JSON_EXT) ? parseJson(content) : parseMarkdown(content);
  if (!candidate) return null;
  const result = WorkflowDefinitionSchema.safeParse(candidate);
  if (!result.success) return null;
  return { ...result.data, source };
}

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseMarkdown(content: string): Record<string, unknown> | null {
  const { frontmatter, body } = splitFrontmatter(content);
  if (!frontmatter) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fm = parsed as Record<string, unknown>;
  const trimmed = body.trim();
  if (fm.description === undefined && trimmed) fm.description = trimmed;
  return fm;
}

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(4, end), body: text.slice(end + 5) };
}
