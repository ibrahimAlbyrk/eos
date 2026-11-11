// What today's code makes of every YAML and frontmatter file: the `yaml` 2.9.0
// parse result as JSON, and what its writer (`stringify`, defaults, as
// FilePageStore / FileUserMemoryStore / UserTemplateService / routes/policy.ts
// call it) writes back. Output: [{ kind, name, yaml, body?, parsed, written }].
//
//   yaml-reference.ts probes <out.json>           the invented probes (fixtures/yaml/probes.json) + shipped policy and workers
//   yaml-reference.ts shipped <out.json>          every shipped prompt file
//   yaml-reference.ts data <home> <out.json>      a data folder (private: keep the output out of git)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "yaml";

const [mode, ...rest] = process.argv.slice(2);
const repo = join(import.meta.dirname, "../../../..");
// The one frontmatter regex every reader shares (infra/src/persistence/frontmatter.ts).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Doc { kind: string; name: string; yaml: string; body?: string; parsed?: unknown; error?: string; written?: string }
const docs: Doc[] = [];

function add(kind: string, name: string, yaml: string, body?: string): void {
  const doc: Doc = { kind, name, yaml, ...(body === undefined ? {} : { body }) };
  try {
    doc.parsed = parse(yaml) ?? null;
    doc.written = stringify(doc.parsed);
  } catch (e) {
    doc.error = (e as Error).name;
  }
  docs.push(doc);
}

function markdownDir(dir: string, kind: string, recurse = false): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (recurse && !name.startsWith(".")) markdownDir(path, kind, true); continue; }
    if (!name.endsWith(".md")) continue;
    const raw = readFileSync(path, "utf8");
    const m = raw.match(FRONTMATTER_RE);
    // The whole file travels too, so the Rust splitter is checked on real input.
    docs.push({ kind: `${kind} (split)`, name, yaml: raw, body: m ? raw.slice(m[0].length) : raw, parsed: m ? m[1] : null });
    if (m) add(kind, name, m[1], raw.slice(m[0].length));
  }
}

if (mode === "shipped") {
  markdownDir(join(repo, "manager/prompts"), "prompt", true);
} else if (mode === "probes") {
  add("policy", "policy.example.yaml", readFileSync(join(repo, "manager/policy.example.yaml"), "utf8"));
  markdownDir(join(repo, "manager/workers"), "worker definition");
  const probes = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/yaml/probes.json"), "utf8")) as Array<{ name: string; value?: unknown; yaml?: string; file?: string }>;
  for (const p of probes) {
    if (p.file !== undefined) {
      const m = p.file.match(FRONTMATTER_RE);
      docs.push({ kind: "probe (split)", name: p.name, yaml: p.file, body: m ? p.file.slice(m[0].length) : p.file, parsed: m ? m[1] : null });
    } else add("probe", p.name, p.yaml ?? stringify(p.value));
  }
} else if (mode === "data") {
  const home = rest[0];
  if (existsSync(join(home, "policy.yaml"))) add("policy", "policy.yaml", readFileSync(join(home, "policy.yaml"), "utf8"));
  markdownDir(join(home, "pages"), "page");
  markdownDir(join(home, "profile/memories"), "memory");
  markdownDir(join(home, "templates"), "template");
  markdownDir(join(home, "workers"), "worker definition");
} else throw new Error("usage: yaml-reference.ts probes <out> | shipped <out> | data <home> <out>");

writeFileSync(rest.at(-1)!, JSON.stringify(docs) + "\n");
const by: Record<string, number> = {};
for (const d of docs) by[d.kind] = (by[d.kind] ?? 0) + 1;
console.log(JSON.stringify({ docs: docs.length, by, parseErrors: docs.filter((d) => d.error).length, writerKeepsBytes: docs.filter((d) => d.written !== undefined && d.written.trimEnd() === d.yaml.trimEnd()).length }));
