// AssembleSystemPrompt — the DPI pipeline (Layer 2). At session start: derive the
// FactSet from the spawn context, select + order the matching fragments, render
// each through Layer 1 (session values exposed as UPPER_SNAKE variables), and
// compose the final system prompt. Runs once per spawn — the prompt is fixed at
// launch via --append-system-prompt-file.
//
// Synchronous: facts are derived directly from the spawn context (the only facts
// ever conditioned on are session-IMMUTABLE — role/isSubagent/isWorktree/
// isAttached). Two namespaces: FACTS (camelCase, drive `when`) vs VARIABLES
// (UPPER_SNAKE, interpolated into bodies).

import { SessionFactsSchema } from "../../../contracts/src/prompt.ts";
import type { SessionFacts } from "../../../contracts/src/prompt.ts";
import type { Fragment, VariableScope } from "../domain/prompt.ts";
import type { PromptRegistry } from "../services/PromptRegistry.ts";
import type { PromptService } from "../services/PromptService.ts";
import { composePrompt } from "../services/prompt-compose.ts";
import { selectFragments } from "../services/fragment-select.ts";

// What the daemon already knows about a spawn — the assembler's only input.
export interface SessionSpawnContext {
  role: "orchestrator" | "worker" | "git";
  parentId: string | null;
  name: string;
  workerId: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
  cwd: string | null;
  worktreeDir: string | null;
  branch: string | null;
  repoRoot: string | null;
  isAttached: boolean;
  hasMcp: boolean;
  canCollaborate: boolean;
  // Worker definition name (immutable fact) + the orchestrator-facing catalog text
  // (interpolation variable). "" for untyped / non-orchestrator.
  workerDefinition: string;
  workerDefinitionCatalog: string;
  // Orchestrator-facing workflow catalogs (interpolation variables, optional —
  // absent ⇒ ""). The LIST of available workflow definitions (per-spawn, dynamic)
  // and the registry-derived capability VOCABULARY (node-type + transform-fn names).
  workflowDefinitionCatalog?: string;
  workflowCapabilityCatalog?: string;
}

export interface AssembleDeps {
  registry: PromptRegistry;
  prompts: PromptService;
}

export interface AssembleResult {
  text: string;
  facts: SessionFacts;
  activeFragmentIds: string[];
}

export function assembleSystemPrompt(
  deps: AssembleDeps,
  ctx: SessionSpawnContext,
  // Per-spawn synthetic fragments (e.g. a resolved worker-definition body) injected
  // alongside the registry's. Rendered from their own AST via renderParsed —
  // their ids are not in the registry, so render(id) would throw on them.
  extraFragments: Fragment[] = [],
): AssembleResult {
  deps.registry.reload(); // fresh read so prompt edits apply on the next spawn
  const facts = deriveFacts(ctx);
  const vars = sessionVars(ctx);

  const selected = selectFragments([...deps.registry.fragments(), ...extraFragments], facts);
  const rendered = selected.map((f) => deps.prompts.renderParsed(f.prompt, {}, vars));

  return {
    text: composePrompt(rendered),
    facts,
    activeFragmentIds: selected.map((f) => f.prompt.id),
  };
}

// Facts derived from the spawn context. Mutable world facts (isGitRepo/os/shell)
// are NOT populated — they're deliberately never conditioned on (the prompt is
// fixed at launch, so gating on a value that can change mid-session is unsound).
function deriveFacts(ctx: SessionSpawnContext): SessionFacts {
  return SessionFactsSchema.parse({
    role: ctx.role,
    isSubagent: ctx.parentId !== null,
    isGitRepo: false,
    isWorktree: ctx.worktreeDir !== null,
    isAttached: ctx.isAttached,
    model: ctx.model,
    effort: ctx.effort,
    permissionMode: ctx.permissionMode,
    os: "",
    shell: "",
    hasMcp: ctx.hasMcp,
    canCollaborate: ctx.canCollaborate,
    workerDefinition: ctx.workerDefinition ?? "",
  });
}

// The session's interpolation variables — UPPER_SNAKE, from the spawn context.
function sessionVars(ctx: SessionSpawnContext): VariableScope {
  return {
    AGENT_NAME: ctx.name,
    WORKER_ID: ctx.workerId ?? "",
    WORKTREE_DIR: ctx.worktreeDir ?? "",
    BRANCH: ctx.branch ?? "",
    REPO_ROOT: ctx.repoRoot ?? "",
    CWD: ctx.cwd ?? "",
    MODEL: ctx.model,
    ROLE: ctx.role,
    EFFORT: ctx.effort ?? "",
    PERMISSION_MODE: ctx.permissionMode,
    AVAILABLE_WORKERS_CATALOG: ctx.workerDefinitionCatalog ?? "",
    AVAILABLE_WORKFLOWS_CATALOG: ctx.workflowDefinitionCatalog ?? "",
    WORKFLOW_CAPABILITY_CATALOG: ctx.workflowCapabilityCatalog ?? "",
  };
}
