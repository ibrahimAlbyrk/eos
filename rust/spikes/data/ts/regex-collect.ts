// Collects the ECMAScript regexes Eos runs from user data and shipped files:
// policy rules (every non-reserved key, rewriteFrom) and worker-definition
// editRegex. Output: { patterns: [{ pattern, rewriteTo?, source }] }.
// Patterns from a data folder are private: write the output outside git.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parse as parseYaml } from "yaml";

const [home, out] = process.argv.slice(2);
if (!home || !out) throw new Error("usage: regex-collect.ts <data folder> <out.json>");
const repo = join(import.meta.dirname, "../../../..");

interface Found { pattern: string; rewriteTo?: string; source: string }
const found: Found[] = [];
const add = (pattern: unknown, source: string, rewriteTo?: unknown): void => {
  if (typeof pattern !== "string" || !pattern) return;
  if (found.some((f) => f.pattern === pattern && f.rewriteTo === rewriteTo)) return;
  found.push({ pattern, source, ...(typeof rewriteTo === "string" ? { rewriteTo } : {}) });
};

const RESERVED = new Set(["tool", "action", "reason", "rewriteField", "rewriteFrom", "rewriteTo"]);
function fromPolicy(file: string, source: string): void {
  if (!existsSync(file)) return;
  const doc = parseYaml(readFileSync(file, "utf8")) as { rules?: Array<Record<string, unknown>> } | null;
  for (const rule of doc?.rules ?? []) {
    for (const [k, v] of Object.entries(rule)) if (!RESERVED.has(k)) add(v, source);
    if (rule.action === "rewrite") add(rule.rewriteFrom, source, rule.rewriteTo);
  }
}
fromPolicy(join(repo, "manager/policy.example.yaml"), "shipped policy.example.yaml");
fromPolicy(join(home, "policy.yaml"), "data policy.yaml");

// editRegex in JSON blobs of state.db (materialized tool scopes, runtime definitions).
function walkJson(v: unknown, source: string): void {
  if (Array.isArray(v)) v.forEach((x) => walkJson(x, source));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "editRegex") add(x, source);
      else walkJson(x, source);
    }
  }
}
const dbFile = join(home, "state.db");
if (existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  for (const [sql, source] of [
    ["SELECT DISTINCT tool_scope AS j FROM workers WHERE tool_scope IS NOT NULL", "data workers.tool_scope"],
    ["SELECT json AS j FROM worker_definitions", "data worker_definitions"],
  ] as const) {
    for (const row of db.prepare(sql).all() as Array<{ j: string }>) {
      try { walkJson(JSON.parse(row.j), source); } catch { /* not JSON */ }
    }
  }
  db.close();
}

// editRegex in frontmatter of templates and worker definitions, and in shipped sources.
function scan(dir: string, source: string, exts: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { scan(path, source, exts); continue; }
    if (!exts.some((e) => name.endsWith(e)) || st.size > 2_000_000) continue;
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/editRegex["']?\s*[:=]\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g)) {
      try { add(m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].slice(1, -1), source); } catch { /* not a literal */ }
    }
  }
}
scan(join(home, "templates"), "data templates", [".md"]);
scan(join(home, "workers"), "data workers", [".md"]);
for (const d of ["manager/prompts", "manager/tools", "manager/claude-plugin", "core/src", "contracts/src", "manager/__tests__", "manager/backends"]) {
  scan(join(repo, d), "shipped sources and tests", [".ts", ".md", ".json"]);
}

writeFileSync(out, JSON.stringify({ patterns: found }, null, 1));
const by: Record<string, number> = {};
for (const f of found) by[f.source] = (by[f.source] ?? 0) + 1;
const feature = (re: RegExp): number => found.filter((f) => re.test(f.pattern)).length;
console.log(JSON.stringify({
  patterns: found.length, by,
  features: {
    lookahead: feature(/\(\?[=!]/), lookbehind: feature(/\(\?<[=!]/), backreference: feature(/\\[1-9]|\\k</),
    namedGroup: feature(/\(\?<[A-Za-z]/), unicodeEscape: feature(/\\u|\\x|\\p\{/), lazy: feature(/[*+?}]\?/),
    inlineFlags: feature(/\(\?[a-z-]+[:)]/),
  },
}));
