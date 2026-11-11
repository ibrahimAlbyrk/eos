#!/usr/bin/env node
// Writes rust/fixtures/workers/vectors.json: what today's TypeScript does with
// worker definitions, for crates/eos-workers and the file adapter.
//
//   node rust/tools/workers-vectors/generate.mjs            write
//   node rust/tools/workers-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 and `npm ci` in contracts/, core/ and infra/.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/workers/vectors.json");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { FileWorkerDefinitionSource, findProjectWorkerDefinitionsDir } = await load("infra/src/worker-definition/FileWorkerDefinitionSource.ts");
const R = await load("core/src/domain/worker-definition-resolution.ts");
const { mergeAvailableWorkers } = await load("core/src/domain/worker-definition-catalog.ts");
const T = await load("core/src/domain/model-tier.ts");
const { WorkerDefinitionSchema } = await load("contracts/src/worker-definition.ts");

// The catalog text is a closure inside the composition root; take its source.
const container = readFileSync(path.join(REPO, "manager/container.ts"), "utf8");
const from = container.indexOf("const renderWorkerDefinitionCatalog = (records: WorkerDefinitionRecord[]): string =>");
const to = container.indexOf('.join("\\n");', from);
if (from < 0 || to < 0) throw new Error("renderWorkerDefinitionCatalog not found in manager/container.ts");
const catalogBody = container.slice(from, to + '.join("\\n")'.length)
  .replace("const renderWorkerDefinitionCatalog = (records: WorkerDefinitionRecord[]): string =>", "");
const renderCatalog = new Function("records", `return (${catalogBody});`);
if (typeof renderCatalog([]) !== "string") throw new Error("renderWorkerDefinitionCatalog did not evaluate");

// ---- files ------------------------------------------------------------------

const BUILTIN = Object.fromEntries(["explorer", "general-purpose", "git", "researcher"].map((n) => [`${n}.md`, readFileSync(path.join(REPO, "manager/workers", `${n}.md`), "utf8")]));
const fm = (yaml, body = "Body.\n") => `---\n${yaml}\n---\n${body}`;
const USER = {
  "reviewer.md": fm("name: reviewer\ndescription: Reviews diffs\nwhenToUse: >\n  After a change\n  is ready.\nmodel: high\neffort: xhigh\npermissionMode: acceptEdits\ntoolsAllow: [Read, Grep]\ntoolsDeny:\n  - Bash(git push:*)\neditRegex: ^src/\nextends: general-purpose\npersistent: true\ncollaborate: false\nisolation: cwd\nbackendKind: claude\nbackendProfile: deepseek"),
  "explorer.md": fm("name: explorer\ndescription: The user's explorer", "User explorer body.\n\n---\nnot a fence\n"),
  "nested/deep/tester.md": fm("name: tester\nextra: kept out\nbody: ignored", ""),
  "no-frontmatter.md": "# Just markdown\n",
  "no-name.md": fm("description: nameless"),
  "empty-name.md": fm('name: ""'),
  "null-model.md": fm("name: null-model\nmodel:"),
  "null-description.md": fm("name: null-description\ndescription: ~"),
  "bad-effort.md": fm("name: bad-effort\neffort: extreme"),
  "bad-mode.md": fm("name: bad-mode\npermissionMode: plan"),
  "number-model.md": fm("name: number-model\nmodel: 5"),
  "number-name.md": fm("name: 42"),
  "tools-string.md": fm("name: tools-string\ntoolsAllow: Read"),
  "bad-yaml.md": fm("name: [unclosed"),
  "list-frontmatter.md": fm("- a\n- b"),
  "scalar-frontmatter.md": fm("just text"),
  "crlf.md": "---\r\nname: crlf\r\n---\r\nbody\r\n",
  "unclosed.md": "---\nname: unclosed\nno closing fence\n",
  "empty-frontmatter.md": "---\n\n---\nbody\n",
  "fence-at-end.md": "---\nname: fence-at-end\n---",
  "second-fence.md": fm("name: second-fence\ndescription: first block", "Text\n---\nname: other\n---\nMore\n"),
  "unicode.md": fm("name: ünïcode\ndescription: \"😀 quoted: yes\"\nwhenToUse: |\n  line one\n  line two", "Gövde\n"),
  "bool-like.md": fm("name: bool-like\npersistent: yes\ncollaborate: true"),
  "not-markdown.txt": fm("name: not-markdown"),
  "dup-a.md": fm("name: dup\ndescription: from a"),
  "dup-b.md": fm("name: dup\ndescription: from b"),
};
const PROJECT = {
  "reviewer.md": fm("name: reviewer\ndescription: The project's reviewer"),
  "local.md": fm("name: local\nextends: reviewer\nmodel: low"),
};

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "eos-workers-vectors-")));
const write = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
};
const dirs = { builtin: path.join(root, "builtin"), user: path.join(root, "home/workers"), project: path.join(root, "repo/.eos/workers") };
write(dirs.builtin, BUILTIN);
write(dirs.user, USER);
write(dirs.project, PROJECT);
mkdirSync(path.join(root, "repo/packages/app"), { recursive: true });
mkdirSync(path.join(root, "elsewhere"), { recursive: true });

const list = (cwd) => {
  const sources = [{ dir: dirs.builtin, source: "builtin" }, { dir: dirs.user, source: "user" }];
  const project = cwd ? findProjectWorkerDefinitionsDir(path.join(root, cwd)) : null;
  if (project) sources.push({ dir: project, source: "project" });
  return new FileWorkerDefinitionSource(sources).list();
};
// One file at a time: what each text parses to.
const each = Object.entries(USER).filter(([rel]) => rel.endsWith(".md")).map(([rel, text]) => {
  const dir = mkdtempSync(path.join(root, "one-"));
  writeFileSync(path.join(dir, "x.md"), text);
  const [rec] = new FileWorkerDefinitionSource([{ dir, source: "user" }]).list();
  return { file: rel, text, record: rec ?? null };
});
const listings = [null, "repo", "repo/packages/app", "elsewhere"].map((cwd) => ({ cwd, records: list(cwd) }));

// Today's reader takes a folder's entries in the order the system lists them;
// the Rust reader takes them by name. On this machine the two must agree for
// the vectors to mean anything: `dup` is the only name two files claim.
const dupWinner = listings[0].records.find((r) => r.name === "dup")?.description;
if (dupWinner !== "from b") throw new Error(`the system lists a folder out of name order here (dup: ${dupWinner})`);

rmSync(root, { recursive: true, force: true });

// ---- resolution ---------------------------------------------------------------

const rec = (name, source, extra = {}) => ({ ...WorkerDefinitionSchema.parse({ name, ...extra }), source });
const RECORDS = [
  rec("general-purpose", "builtin", { description: "base", whenToUse: "anything", model: "high", effort: "xhigh", toolsDeny: ["WebFetch"], body: "base body" }),
  rec("git", "builtin", { permissionMode: "bypassPermissions", isolation: "cwd" }),
  rec("reviewer", "user", { extends: "general-purpose", model: "medium", toolsAllow: ["Read"], editRegex: "^src/", body: "review" }),
  rec("reviewer", "project", { extends: "reviewer", description: "project reviewer", persistent: true }),
  rec("strict", "project", { extends: "reviewer", editRegex: "^/abs/", collaborate: true, backendKind: "claude", backendProfile: "deepseek" }),
  rec("loop-a", "user", { extends: "loop-b", model: "low" }),
  rec("loop-b", "user", { extends: "loop-a", effort: "low" }),
  rec("self", "user", { extends: "self", description: "extends itself" }),
  rec("orphan", "user", { extends: "nobody", body: "orphan" }),
  rec("plain", "runtime", { description: "no extends", editRegex: "src/.*\\.ts$" }),
  rec("general-purpose", "runtime", { description: "runtime override", body: "runtime body" }),
  rec("chain-3", "runtime", { extends: "strict", toolsDeny: [] }),
];
const NAMES = ["general-purpose", "git", "reviewer", "strict", "loop-a", "loop-b", "self", "orphan", "plain", "chain-3", "missing", ""];
const SLICES = [RECORDS, RECORDS.slice(0, 5), RECORDS.slice(0, 3), []];
const resolved = [];
for (let s = 0; s < SLICES.length; s++) for (const name of NAMES) {
  const def = R.resolveWorkerDefinitionByName(name, SLICES[s]);
  const FIELDS = ["model", "effort", "permissionMode", "backendKind", "backendProfile", "persistent", "collaborate", "isolation"];
  const sets = [[], ["model"], ["effort", "permissionMode"], FIELDS];
  resolved.push({
    slice: s, name,
    // `extends: undefined` is how the overlay marks it used up: JSON drops it.
    definition: def ? JSON.parse(JSON.stringify(def)) : null,
    scope: def ? R.materializeToolScope(def) : null,
    restrictive: def ? R.isToolScopeRestrictive(R.materializeToolScope(def)) : null,
    defaults: def ? sets.map((has) => ({ has, defaults: R.applyWorkerDefinitionDefaults(def, (f) => has.includes(f)) })) : null,
  });
}

const names = [[undefined, undefined], ["reviewer", undefined], ["  reviewer  ", "git"], ["", "git"], ["   ", undefined], [undefined, "git"], [undefined, "worker"], ["git", "git"]]
  .map(([from, role]) => ({ from: from ?? null, role: role ?? null, name: R.resolveDefinitionName(from, role) }));

const BACKENDS = ["deepseek", "kimi"];
const MODELS = [undefined, "", "opus", "deepseek/deepseek-v4-pro", "deepseek/foo/bar", "anthropic/claude-opus-4", "/x", "deepseek/", "kimi/k2", "/"];
const PINNED = [undefined, "", "deepseek", "openrouter"];
const combined = [];
for (const model of MODELS) for (const pinned of PINNED) {
  const out = R.resolveCombinedModel(model, pinned, new Set(BACKENDS));
  combined.push({ model: model ?? null, pinned: pinned ?? null, out: { model: out.model ?? null, backendProfile: out.backendProfile ?? null },
    split: model === undefined ? null : R.splitProviderModel(model, new Set(BACKENDS)) });
}

const DISK = [rec("general-purpose", "builtin", { whenToUse: "Default\n  worker.\t Use  it." }), rec("git", "builtin", { permissionMode: "bypassPermissions" }),
  rec("reviewer", "user", { description: "Reviews", model: "high", effort: "max", permissionMode: "acceptEdits" }), rec("dup", "user", { description: "user" }), rec("dup", "project", { whenToUse: "project" })];
const RUNTIME = [rec("reviewer", "runtime", { whenToUse: "runtime", effort: "low" }), rec("custom", "runtime", { model: "deepseek/x" }), rec("bare", "runtime")];
const merges = [[DISK, RUNTIME], [DISK, []], [[], RUNTIME], [[], []]].map(([disk, runtime]) => {
  const merged = mergeAvailableWorkers(disk, runtime);
  return { disk, runtime, merged, catalog: renderCatalog(merged) };
});

const tier = (name, model, hint) => ({ name, model, ...(hint ? { hint } : {}) });
const IDENTITIES = [
  T.CLAUDE_IDENTITY,
  { persona: "DeepSeek", tiers: [tier("high", "v4-pro"), tier("medium", "v4"), tier("low", "v4-lite")], effortSupported: false },
  { persona: "Kimi", tiers: [tier("high", "k2", "the big one"), tier("low", "k2-mini")], defaultTier: "low", effortSupported: true },
  { persona: "Custom", tiers: [tier("ultra", "u1"), tier("lite", "l1")], defaultTier: "nope", effortSupported: false },
  { persona: "Mid", tiers: [tier("medium", "only")], effortSupported: false },
  { persona: "LowOnly", tiers: [tier("max", "m"), tier("low", "l")], effortSupported: false },
];
const ASKED = ["max", "high", "medium", "low", "ultra", "lite", "opus", "sonnet", "haiku", "fable", "claude-opus-4", "", "nope"];
const tiers = IDENTITIES.map((identity) => ({
  identity,
  defaultTier: T.defaultTierName(identity),
  defaultValid: T.defaultTierIsValid(identity),
  isClaude: T.isClaudeIdentity(identity),
  names: T.tierNames(identity),
  resolved: Object.fromEntries(ASKED.map((m) => [m, T.resolveTier(m, identity)])),
}));

const text = JSON.stringify({
  about: "Worker definitions as today's TypeScript reads and resolves them. files: the three folders; listings: FileWorkerDefinitionSource.list() per working folder; each: one file at a time.",
  files: { builtin: BUILTIN, user: USER, project: PROJECT },
  listings, each,
  records: RECORDS, slices: SLICES.map((s) => s.length), resolved, names,
  backends: BACKENDS, combined, merges, tiers,
}, null, 1) + "\n";

if (process.argv.includes("--check")) {
  const same = existsSync(OUT) && readFileSync(OUT, "utf8") === text;
  if (!same) console.error("vectors.json would change");
  process.exit(same ? 0 : 1);
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, text);
console.log(`${each.length} files, ${listings.length} listings, ${resolved.length} resolutions, ${combined.length} models, ${tiers.length} identities`);
