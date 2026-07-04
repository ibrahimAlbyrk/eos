// Dev utility: render the REAL assembled system prompt an orchestrator or worker
// session receives, offline (no daemon). Same code path as the spawn chokepoint in
// manager/container.ts — assembleSystemPrompt() + resolveProviderIdentity() + the
// tier/effort render helpers — so what it prints is byte-for-byte what a session gets.
//
// Usage:
//   bash scripts/preview-prompt.sh <orchestrator|worker> [--provider <claude|preset>]
//        [--subagent] [--worktree] [--definition <name>] [-o <file>]
// Defaults: claude provider; worker previews as a subagent (all worker role fragments
// gate on isSubagent=true — a non-subagent worker is just the preamble); stdout.

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";

import { FilePromptSource } from "../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../core/src/services/PromptRegistry.ts";
import { PromptService } from "../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../core/src/use-cases/AssembleSystemPrompt.ts";
import type { SessionSpawnContext } from "../core/src/use-cases/AssembleSystemPrompt.ts";
import { TOOL_NAME_VARS } from "../manager/prompt-tool-names.ts";
import { resolveProviderIdentity } from "../manager/shared/provider-identity.ts";
import { renderModelTierTable, renderEffortSection, defaultEffortFor } from "../manager/shared/tier-prompt-render.ts";
import { PROVIDER_PRESETS, findPreset } from "../manager/shared/provider-presets.ts";
import type { ProviderIdentity } from "../core/src/domain/model-tier.ts";
import { InMemoryStepExecutorRegistry } from "../core/src/workflow/registry.ts";
import { registerBuiltinExecutors } from "../core/src/workflow/register-builtins.ts";
import { renderCapabilityCatalog } from "../core/src/domain/workflow-capability-catalog.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const promptsDir = join(REPO, "manager", "prompts");

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };

function deps() {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  return { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
}

// Deterministic daemon constant (container.ts) — reproduced offline from the builtin
// executor/transform registries. Orchestrator-only var, harmless for workers.
function workflowCapabilityCatalog(): string {
  const reg = new InMemoryStepExecutorRegistry();
  const { transforms } = registerBuiltinExecutors(reg);
  return renderCapabilityCatalog(reg.types(), transforms.names());
}

// Resolve a provider name to its ProviderIdentity via the REAL resolver, branching on
// descriptor.models.kind + preset origin (no live config). "claude" → Claude identity;
// any preset id (deepseek, openai, gemini, …) → that preset's persona/tiers/effort.
export function resolveIdentity(provider: string): ProviderIdentity {
  if (provider === "claude") {
    return resolveProviderIdentity({ kind: "claude-sdk", label: "Claude SDK", models: { kind: "claude" } } as any, undefined);
  }
  const preset = findPreset(provider);
  if (!preset) {
    const known = ["claude", ...PROVIDER_PRESETS.map((p) => p.id)].join(", ");
    throw new Error(`unknown provider "${provider}". Known: ${known}`);
  }
  const descriptor = { kind: preset.kind, label: preset.label, models: { kind: "openai-compatible" } } as any;
  return resolveProviderIdentity(descriptor, { baseUrl: preset.baseUrl, model: preset.defaultModel });
}

export interface PreviewOpts {
  role: "orchestrator" | "worker";
  provider: string;      // "claude" | preset id
  subagent: boolean;     // isSubagent fact
  worktree: boolean;     // isWorktree fact
  definition: string;    // workerDefinition fact ("" = untyped)
}

export function renderPreview(opts: PreviewOpts) {
  const identity = resolveIdentity(opts.provider);
  const ctx: SessionSpawnContext = {
    role: opts.role,
    parentId: opts.subagent ? "orch-preview" : null,
    name: opts.role,
    workerId: opts.role === "orchestrator" ? "o-preview" : "w-preview",
    model: identity.tiers.high,
    effort: null,
    permissionMode: "acceptEdits",
    cwd: REPO,
    worktreeDir: opts.worktree ? "/path/to/worktree" : null,
    branch: opts.worktree ? "eos-preview" : null,
    repoRoot: opts.worktree ? REPO : null,
    isAttached: false,
    hasMcp: false,
    canCollaborate: false,
    workerDefinition: opts.definition,
    workerDefinitionCatalog: "",       // runtime (disk + runtime defs) → assembler fallback ""
    workflowDefinitionCatalog: "",     // runtime (disk + runtime defs) → assembler fallback ""
    workflowCapabilityCatalog: workflowCapabilityCatalog(),
    personaName: identity.persona,
    modelTierTable: renderModelTierTable(identity),
    effortSection: renderEffortSection(identity),
    defaultEffort: defaultEffortFor(identity),
    effortSupported: identity.effortSupported,
  };
  const r = assembleSystemPrompt(deps(), ctx);
  return { ...r, identity, defaultEffort: ctx.defaultEffort as string };
}

function parseArgs(argv: string[]): PreviewOpts & { out: string | null } {
  const opts = { role: "" as any, provider: "claude", subagent: false, worktree: false, definition: "", out: null as string | null };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") opts.provider = argv[++i] ?? "";
    else if (a === "--definition") opts.definition = argv[++i] ?? "";
    else if (a === "-o" || a === "--out") opts.out = argv[++i] ?? "";
    else if (a === "--subagent") opts.subagent = true;
    else if (a === "--worktree") opts.worktree = true;
    else if (a.startsWith("-")) throw new Error(`unknown flag "${a}"`);
    else positional.push(a);
  }
  opts.role = positional[0] as any;
  if (opts.role !== "orchestrator" && opts.role !== "worker") {
    throw new Error(`role must be "orchestrator" or "worker" (got "${opts.role ?? ""}")`);
  }
  // A worker is canonically a subagent — its role fragments require it. Default it on
  // unless caller is previewing the (near-empty) non-subagent case explicitly.
  if (opts.role === "worker" && !opts.subagent) opts.subagent = true;
  return opts;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`preview-prompt: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const { out, ...opts } = parsed;
  let text;
  try {
    text = renderPreview(opts).text;
  } catch (e) {
    console.error(`preview-prompt: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (out) { writeFileSync(out, text); console.error(`wrote ${out} (${text.length} chars)`); }
  else process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
