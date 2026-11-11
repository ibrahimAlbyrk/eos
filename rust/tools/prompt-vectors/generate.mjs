#!/usr/bin/env node
// Writes rust/fixtures/prompts: what today's TypeScript prompt system produces,
// so the Rust port (crates/eos-prompts, the library in eos-store-files) can be
// held to it byte for byte.
//
//   node rust/tools/prompt-vectors/generate.mjs            write
//   node rust/tools/prompt-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 and `npm ci` in contracts/, core/ and infra/. The tool
// definitions under manager/ import `zod`; it is resolved from contracts/, so
// manager/ needs no install.
//
// library.json   every prompt as FilePromptSource reads it, the catalog rows of
//                GET /api/prompts, each prompt rendered alone with sample values,
//                the tool descriptions, the tool-name variables, the tier and
//                effort texts per provider, the visual-answer level texts.
// assembled.json assembleSystemPrompt over a matrix of session facts
//                (role × subagent × worktree × worker definition × plugins off,
//                with provider, collaboration, attachment, visual-answer level
//                and user profile cycled through). Every case carries the
//                SHA-256 of its text; a spread of them carries the text itself.
// engine.json    the template engine and the condition evaluator on invented
//                inputs, errors included.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/prompts");
const zod = pathToFileURL(path.join(REPO, "contracts/node_modules/zod/index.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === "zod" ? { url: zod, shortCircuit: true } : next(specifier, context);
  },
});
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { FilePromptSource } = await load("infra/src/prompt/FilePromptSource.ts");
const { PromptRegistry } = await load("core/src/services/PromptRegistry.ts");
const { PromptService } = await load("core/src/services/PromptService.ts");
const { assembleSystemPrompt } = await load("core/src/use-cases/AssembleSystemPrompt.ts");
const { parsePrompt } = await load("core/src/services/prompt-parse.ts");
const { parseTemplate, renderTemplate } = await load("core/src/services/template-engine.ts");
const { evaluateCondition } = await load("core/src/services/condition-eval.ts");
const { composeAppendedPrompt } = await load("core/src/services/compose-appended-prompt.ts");
const { selectInjectableMemory } = await load("core/src/services/select-injectable-memory.ts");
const { toFragment } = await load("core/src/domain/prompt.ts");
const { DEFAULT_USER_PREFERENCES } = await load("core/src/services/render-user-profile.ts");
const { defaultTierName } = await load("core/src/domain/model-tier.ts");
const { TOOL_NAME_VARS } = await load("manager/prompt-tool-names.ts");
const { renderModelTierTable, renderEffortSection, defaultEffortFor } = await load("manager/shared/tier-prompt-render.ts");
const { resolveProviderIdentity } = await load("manager/shared/provider-identity.ts");
const { PROVIDER_PRESETS } = await load("manager/shared/provider-presets.ts");
const { genuiPromptVariables } = await load("manager/modules/genui/prompt.ts");
const { catalogPrompt } = await load("contracts/src/genui/prompt.ts");
const { BUILTIN_PLUGINS } = await load("contracts/src/builtin-plugins.ts");
const { ConditionSchema } = await load("contracts/src/prompt.ts");

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const promptsDir = path.join(REPO, "manager/prompts");
const sha = (text) => createHash("sha256").update(text).digest("hex");
// A value JSON cannot hold (`undefined`) is written as absent; errors as their message.
const attempt = (fn) => { try { return { ok: fn() }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } };

// ---- the library --------------------------------------------------------------

const source = new FilePromptSource([promptsDir]);
const raw = source.list();
const registry = new PromptRegistry(source, quiet);
const globals = { ...TOOL_NAME_VARS, GENUI_CATALOG: catalogPrompt() };
const service = new PromptService(registry, globals);

const prompts = raw.map((r) => ({ id: r.id, file: path.relative(promptsDir, r.sourcePath), frontmatter: r.frontmatter, body: r.body }));
const catalog = registry.list().map((p) => {
  const frag = toFragment(p);
  return {
    id: p.id, description: p.frontmatter.description ?? null, layer: frag?.dpi.layer ?? null, priority: frag?.dpi.priority ?? null,
    conditional: Boolean(frag?.dpi.when), variables: p.frontmatter.variables, referenced: p.referenced, warnings: p.warnings,
  };
});
// Each prompt on its own: once with nothing given, once with every declared
// variable set to a marker (the session variables included).
const renders = registry.list().map((p) => {
  const locals = Object.fromEntries(p.frontmatter.variables.filter((v) => !(v in globals)).map((v) => [v, `‹${v}›\nsecond line`]));
  return { id: p.id, bare: service.render(p.id), locals, filled: service.render(p.id, locals) };
});

const toolNames = [...registry.list().filter((p) => p.id.startsWith("tool/")).map((p) => p.id.slice(5)), "no_such_tool"];
// renderToolDescriptions with its stderr line left out.
const toolDescriptions = Object.fromEntries(toolNames.map((name) => {
  const out = attempt(() => service.render(`tool/${name}`).trim());
  return [name, out.ok ?? name];
}));

const identity = (name, id) => ({ name, identity: id, defaultTier: defaultTierName(id), tierTable: renderModelTierTable(id), effortSection: renderEffortSection(id), defaultEffort: defaultEffortFor(id) });
const IDENTITIES = [
  identity("claude", resolveProviderIdentity({ kind: "claude", label: "Claude", models: { kind: "claude" } }, undefined)),
  ...PROVIDER_PRESETS.map((preset) => identity(preset.id, resolveProviderIdentity(
    { kind: preset.kind, label: preset.label, models: { kind: "openai-compatible" } }, { baseUrl: preset.baseUrl, model: preset.defaultModel }))),
  identity("self-hosted", resolveProviderIdentity({ kind: "openai", label: "My Proxy", models: { kind: "openai-compatible" } }, { baseUrl: "http://10.0.0.5:8080/v1", model: "local-model" })),
  identity("custom-tiers", resolveProviderIdentity({ kind: "claude", label: "Claude", models: { kind: "claude" } },
    { tiers: [{ name: "ultra", model: "fable", hint: "only when asked" }, { name: "std", model: "sonnet" }], defaultTier: "std" })),
  identity("one-tier", { persona: "Solo", tiers: [{ name: "only", model: "m1" }], effortSupported: false }),
];
const GENUI_LEVELS = [undefined, "rich", "balanced", "text", "weird"];
const genui = GENUI_LEVELS.map((level) => ({ level: level ?? null, variables: genuiPromptVariables(level) }));

// ---- the assembled prompt -------------------------------------------------------

const definitionBody = (name) => {
  const text = readFileSync(path.join(REPO, "manager/workers", `${name}.md`), "utf8");
  return text.slice(text.indexOf("\n---\n", 4) + 5);
};
const DEFINITIONS = [
  { name: "", body: null },
  { name: "general-purpose", body: definitionBody("general-purpose") },
  { name: "explorer", body: definitionBody("explorer") },
  { name: "researcher", body: definitionBody("researcher") },
  { name: "git", body: definitionBody("git") },
  { name: "perf-profiler", body: "You profile {{AGENT_NAME}} in {{CWD}}.\n{{#if WORKTREE_DIR}}Worktree: {{WORKTREE_DIR}}{{/if}}{{#unless EFFORT}} (no effort set){{/unless}}\n" },
  { name: "blank-body", body: "   \n" },
  { name: "broken-body", body: "An unclosed {{#if X}} block" },
];
const pluginIds = Object.values(BUILTIN_PLUGINS);
const PLUGINS_OFF = [[], ["eos.browser"], ["eos.pages"], pluginIds, ["eos.pages", "eos.browser", "user.thing"]];
const ROLES = ["orchestrator", "worker", "git", "focused"];
const PROFILES = [undefined, "", "`<user_profile>`\n\nName: Ada\nPrefers {{braces}} left alone.\n\n`</user_profile>`", DEFAULT_USER_PREFERENCES];
const CATALOG = "- explorer [medium/medium]: Dispatch for read-only exploration.\n- general-purpose: Use when no specialist matches.";

function context(role, subagent, worktree, definition, off, n) {
  const id = IDENTITIES[n % IDENTITIES.length];
  const level = GENUI_LEVELS[n % GENUI_LEVELS.length];
  const profile = PROFILES[n % PROFILES.length];
  const withIdentity = n % 7 !== 6; // now and then a caller that knows no provider (the preview route)
  return {
    role,
    parentId: subagent ? "o-abc123" : null,
    name: n % 3 === 0 ? "Fix the login bug" : role,
    workerId: n % 5 === 4 ? null : `w-${String(n).padStart(8, "0")}`,
    model: id.identity.tiers[0].model,
    effort: [null, "high", "xhigh"][n % 3],
    permissionMode: n % 2 ? "acceptEdits" : "bypassPermissions",
    cwd: n % 4 === 3 ? null : "/repo/app",
    worktreeDir: worktree ? "/repo/.eos-worktrees/eos-fix" : null,
    branch: worktree ? "eos-fix" : null,
    repoRoot: worktree ? "/repo/app" : null,
    isAttached: n % 4 === 1,
    hasMcp: n % 6 === 5,
    canCollaborate: n % 3 === 1,
    workerDefinition: definition.name,
    workerDefinitionCatalog: role === "orchestrator" && n % 2 === 0 ? CATALOG : "",
    ...(withIdentity ? {
      personaName: id.identity.persona, modelTierTable: id.tierTable, defaultTier: id.defaultTier,
      effortSection: id.effortSection, defaultEffort: id.defaultEffort, effortSupported: id.identity.effortSupported,
    } : {}),
    ...(profile === undefined ? {} : { userProfile: profile }),
    ...(n % 5 === 3 ? {} : { variables: { ...genuiPromptVariables(level), ...(n % 11 === 10 ? { AGENT_NAME: "overridden by a module" } : {}) } }),
    ...(off.length || n % 2 ? { disabledPlugins: off } : {}),
  };
}

// The synthetic role/20 fragment a resolved definition body becomes (manager/container.ts).
function extras(definition) {
  if (!definition.name || !definition.body || !definition.body.trim()) return [];
  const rawPrompt = { id: `definition/${definition.name}`, frontmatter: { dpi: { layer: "role", priority: 20 }, variables: [] }, body: definition.body };
  try {
    const frag = toFragment(parsePrompt(rawPrompt));
    return frag ? [frag] : [];
  } catch { return []; }
}

const deps = { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
const cases = [];
let n = 0;
for (const role of ROLES) for (const subagent of [false, true]) for (const worktree of [false, true])
  for (let d = 0; d < DEFINITIONS.length; d++) for (const off of PLUGINS_OFF) {
    const ctx = context(role, subagent, worktree, DEFINITIONS[d], off, n);
    const result = assembleSystemPrompt(deps, ctx, extras(DEFINITIONS[d]));
    const keep = n % 29 === 0 || (d === 0 && off.length === 0);
    cases.push({ ctx, definition: d, sha256: sha(result.text), length: result.text.length, facts: result.facts, activeFragmentIds: result.activeFragmentIds, ...(keep ? { text: result.text } : {}) });
    n++;
  }
// What the preview route assembles: the request's defaults and nothing else.
const previewCtx = { role: "worker", parentId: null, name: "preview", workerId: null, model: "high", effort: null, permissionMode: "bypassPermissions",
  cwd: null, worktreeDir: null, branch: null, repoRoot: null, isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "", workerDefinitionCatalog: "",
  userProfile: DEFAULT_USER_PREFERENCES };
const preview = assembleSystemPrompt(deps, previewCtx);
cases.push({ ctx: previewCtx, definition: 0, sha256: sha(preview.text), length: preview.text.length, facts: preview.facts, activeFragmentIds: preview.activeFragmentIds, text: preview.text });

// The offline preview (scripts/preview-prompt.mts), with this checkout's path written as {repo}.
const { renderPreview } = await load("scripts/preview-prompt.mts");
const previews = [
  { role: "orchestrator", provider: "claude", subagent: false, worktree: false, definition: "" },
  { role: "worker", provider: "claude", subagent: true, worktree: true, definition: "" },
  { role: "worker", provider: "deepseek", subagent: true, worktree: false, definition: "explorer" },
  { role: "worker", provider: "claude", subagent: false, worktree: false, definition: "" },
].map((opts) => {
  const result = renderPreview(opts);
  return { opts, text: result.text.split(REPO).join("{repo}"), activeFragmentIds: result.activeFragmentIds };
});

// ---- the engine ---------------------------------------------------------------

const TEMPLATES = [
  "", "plain text", "{{A}}", "a {{ A }} b {{A.b}} c", "{{  A\n}}", "{{#if A}}yes{{/if}}", "{{#unless A}}no{{/unless}}", "{{#if A}}x{{#unless B}}y{{/unless}}z{{/if}}",
  "{{#if A.b}}deep{{/if}}", "{{LIST}}|{{LIST.length}}|{{LIST.0}}|{{LIST.x}}", "{{N}} {{F}} {{T}} {{NIL}} {{MISSING}} {{O}} {{O.k}} {{O.k.z}} {{S.length}}",
  "{{#if LIST}}has{{/if}}{{#unless EMPTY}}none{{/unless}}{{#if ZERO}}0{{/if}}{{#if BLANK}}b{{/if}}{{#if F}}f{{/if}}{{#if O}}o{{/if}}{{#if NIL}}n{{/if}}",
  "unclosed {{ A", "}} stray {{A}} }}", "{{A}}}", "{{{A}}", "{{}}", "{{ }}", "{{a b}}", "{{1a}}", "{{_a.b_c.9}}", "{{a-b}}", "{{#if}}", "{{#if }}x{{/if}}", "{{#if\tA}}x{{/if}}",
  "{{#if a b}}x{{/if}}", "{{#if A}}open", "{{/if}}", "{{#if A}}x{{/unless}}", "{{#unless A}}x{{/if}}", "{{#if A}}{{#if B}}x{{/if}}", "{{#each A}}x{{/each}}", "{{else}}",
  "{{#if  A }}two spaces{{/if}}", "{{ #if A }}padded{{ /if }}", "{{#unless   A.b  }}u{{/unless}}", "line\n{{#if A}}\nblock\n{{/if}}\nend\n", "{{A}}{{A}}{{B}}{{A.x}}",
  "{{LB}}nodes.x{{RB}}", " {{ A }}﻿", "😀{{A}}😀",
];
const SCOPE = { A: "alpha", B: "", LIST: ["one", "two"], EMPTY: [], ZERO: 0, N: 42, F: false, T: true, NIL: null, O: { k: "v" }, S: "str", BLANK: " ", LB: "{{", RB: "}}", _a: { b_c: { 9: "nine" } } };
const templates = TEMPLATES.map((body) => {
  const parsed = attempt(() => parseTemplate(body));
  if (parsed.error) return { body, error: parsed.error };
  return { body, referenced: parsed.ok.referenced, rendered: renderTemplate(parsed.ok.nodes, SCOPE), empty: renderTemplate(parsed.ok.nodes, {}) };
});

const FACTS = { role: "worker", isSubagent: true, isWorktree: false, effort: null, model: "opus", count: 0, blank: "", list: ["a"], none: [], "plugin-off:eos.pages": true, n: 3 };
const CONDITIONS = [
  { fact: "role" }, { fact: "missing" }, { fact: "isWorktree" }, { fact: "effort" }, { fact: "count" }, { fact: "blank" }, { fact: "list" }, { fact: "none" },
  { fact: "role", eq: "worker" }, { fact: "role", eq: "git" }, { fact: "effort", eq: null }, { fact: "missing", eq: null }, { fact: "isWorktree", eq: false }, { fact: "count", eq: 0 },
  { fact: "n", eq: 3 }, { fact: "n", eq: "3" }, { fact: "list", eq: ["a"] }, { fact: "role", ne: "worker" }, { fact: "missing", ne: "x" }, { fact: "effort", ne: null },
  { fact: "role", in: ["worker", "git"] }, { fact: "role", in: [] }, { fact: "effort", in: [null] }, { fact: "missing", in: [null] }, { fact: "role", nin: ["git"] }, { fact: "role", nin: ["worker"] },
  { fact: "role", exists: true }, { fact: "effort", exists: true }, { fact: "effort", exists: false }, { fact: "missing", exists: false }, { fact: "count", exists: true },
  { fact: "count", truthy: true }, { fact: "count", truthy: false }, { fact: "list", truthy: true }, { fact: "none", truthy: false }, { fact: "role", truthy: false },
  { fact: "role", eq: "git", ne: "git" }, { fact: "role", ne: "worker", in: ["worker"] }, { fact: "role", eq: "worker", truthy: false },
  { all: [] }, { any: [] }, { all: [{ fact: "role", eq: "worker" }, { fact: "isSubagent", eq: true }] }, { all: [{ fact: "role" }, { fact: "isWorktree" }] },
  { any: [{ fact: "isWorktree" }, { fact: "role", eq: "worker" }] }, { not: { fact: "plugin-off:eos.pages" } }, { not: { fact: "plugin-off:eos.browser" } },
  { all: [{ any: [{ fact: "missing" }, { not: { fact: "isWorktree" } }] }, { not: { all: [{ fact: "role", eq: "git" }] } }] },
  { all: [{ fact: "role", eq: "worker" }], fact: "ignored", eq: "nope" }, { not: { fact: "role" }, any: [] },
  // Not conditions at all.
  {}, { fact: "" }, { fact: 5 }, { fact: "role", in: "worker" }, { fact: "role", exists: "yes" }, { all: {} }, { not: [] }, "role", null, { all: [{ fact: "role" }, {}] },
];
const conditions = CONDITIONS.map((condition) => {
  const parsed = ConditionSchema.safeParse(condition);
  return { condition, valid: parsed.success, ...(parsed.success ? { result: evaluateCondition(parsed.data, FACTS) } : {}) };
});

// Frontmatter the parser accepts or refuses, and what makes a fragment.
const FRONTMATTERS = [
  {}, { description: "d", variables: ["A", "lower", "B_2"] }, { variables: [] }, { variables: "A" }, { variables: [""] }, { variables: [1] }, { description: 5 }, { id: 5 }, { id: "x", extra: { kept: true } },
  { description: null }, { variables: null }, { id: null }, "text", null, [], 5,
  { dpi: { layer: "role", priority: 20 } }, { dpi: {} }, { dpi: null }, { dpi: "role" }, { dpi: { layer: "nope" } }, { dpi: { priority: 1.5 } }, { dpi: { priority: "1" } }, { dpi: { priority: -3 } },
  { dpi: { when: { fact: "role" } } }, { dpi: { when: null } }, { dpi: { when: {} } }, { dpi: { overrides: ["a"] } }, { dpi: { overrides: "a" } }, { dpi: { layer: null } }, { dpi: { overrides: null } }, { dpi: { priority: null } },
  { dpi: { layer: "core", extra: 1, when: { all: [{ fact: "role", eq: "worker" }] } } },
];
const frontmatters = FRONTMATTERS.map((frontmatter) => {
  const parsed = attempt(() => parsePrompt({ id: "p", frontmatter, body: "{{A}} {{C}}" }));
  if (parsed.error) return { frontmatter, valid: false };
  const frag = toFragment(parsed.ok);
  return { frontmatter, valid: true, variables: parsed.ok.frontmatter.variables, warnings: parsed.ok.warnings,
    dpi: frag ? { layer: frag.dpi.layer, priority: frag.dpi.priority, conditional: Boolean(frag.dpi.when), overrides: frag.dpi.overrides ?? null } : null };
});

// Memory folded behind the assembled text for a backend that does not load it itself.
const doc = (sourceId, sourceLabel, p, content, nativeFor = []) => ({ sourceId, sourceLabel, nativeFor, path: p, level: "project", content });
const SNAPSHOTS = [
  null, { docs: [] }, { docs: [doc("claude", "CLAUDE.md", "/u/.claude/CLAUDE.md", "  \n")] },
  { docs: [doc("claude", "CLAUDE.md", "/u/.claude/CLAUDE.md", "User rules.\n", ["claude"]), doc("agents", "AGENTS.md", "/repo/AGENTS.md", "\nAgents.\n"), doc("claude", "CLAUDE.md", "/repo/CLAUDE.md", "Project rules.")] },
];
const memory = [];
for (const dpi of [null, "", "  \n", "DPI text.\n"]) for (const snapshot of SNAPSHOTS) for (const kind of ["claude", "openai"]) {
  const injectable = snapshot ? selectInjectableMemory(snapshot, kind) : null;
  memory.push({ dpi, snapshot, kind, out: composeAppendedPrompt(dpi, injectable) });
}

const files = {
  "library.json": JSON.stringify({ prompts, catalog, renders, toolDescriptions, toolNameVars: TOOL_NAME_VARS, genuiCatalogSha256: sha(catalogPrompt()), identities: IDENTITIES, genui, defaultUserPreferences: DEFAULT_USER_PREFERENCES, previews }) + "\n",
  "assembled.json": JSON.stringify({ definitions: DEFINITIONS, cases }) + "\n",
  "engine.json": JSON.stringify({ scope: SCOPE, templates, facts: FACTS, conditions, frontmatters, memory }, null, 1) + "\n",
};
if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, text] of Object.entries(files)) {
    if (!existsSync(path.join(OUT, name)) || readFileSync(path.join(OUT, name), "utf8") !== text) { console.error(`${name} would change`); stale = true; }
  }
  process.exit(stale ? 1 : 0);
}
mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(files)) writeFileSync(path.join(OUT, name), text);
console.log(`${prompts.length} prompts, ${cases.length} assembled (${cases.filter((c) => c.text !== undefined).length} with text), ${templates.length} templates, ${conditions.length} conditions`);
