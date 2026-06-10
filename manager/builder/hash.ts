// Deterministic content hashing for build inputs. A stamp is sha256 over a
// sorted list of "label\0sha256(bytes)" lines, so it is independent of walk
// order, mtimes, and machine paths (labels are logical, not absolute).
// RECIPE_VERSION is part of the hash — bump it to force a global rebuild
// when step semantics change.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const RECIPE_VERSION = "1";

export type ExcludeFn = (relPath: string) => boolean;

export interface TreeSpec {
  root: string;
  prefix: string;
  exclude?: ExcludeFn;
}

export interface FileSpec {
  path: string;
  label: string;
}

export interface StampSpec {
  trees?: TreeSpec[];
  /** Absent files hash as "absent" instead of erroring (e.g. optional config.json). */
  files?: FileSpec[];
  extra?: Record<string, string>;
}

function hashFile(abs: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function walk(dir: string, rel: string, exclude: ExcludeFn, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (exclude(relPath)) continue;
    const abs = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(abs, relPath, exclude, out);
    } else {
      out.push(relPath);
    }
  }
}

export function computeStamp(spec: StampSpec): string {
  const lines: string[] = [];
  for (const tree of spec.trees ?? []) {
    const exclude = tree.exclude ?? (() => false);
    const rels: string[] = [];
    walk(tree.root, "", exclude, rels);
    for (const rel of rels) {
      const h = hashFile(join(tree.root, rel));
      if (h !== null) lines.push(`${tree.prefix}/${rel}\0${h}`);
    }
  }
  for (const f of spec.files ?? []) {
    lines.push(`${f.label}\0${hashFile(f.path) ?? "absent"}`);
  }
  for (const key of Object.keys(spec.extra ?? {}).sort()) {
    lines.push(`extra:${key}\0${spec.extra![key]}`);
  }
  lines.sort();
  const h = createHash("sha256");
  h.update(`recipe:${RECIPE_VERSION}\n`);
  for (const line of lines) h.update(`${line}\n`);
  return h.digest("hex");
}
