// AssembleSystemPrompt — the DPI pipeline (Layer 2). At session start: derive a
// base FactSet from the spawn context, let providers add world-derived facts
// (git, environment), select + order the matching fragments, render each through
// Layer 1 (session values exposed as UPPER_SNAKE variables), and compose the
// final system prompt. Runs once per spawn — the prompt is fixed at launch via
// --append-system-prompt-file.
//
// Two namespaces, deliberately separate: FACTS (camelCase: role, isGitRepo, …)
// drive `when` conditions; VARIABLES (UPPER_SNAKE: BRANCH, AGENT_NAME, …) are
// interpolated into bodies.

import { SessionFactsSchema } from "../../../contracts/src/prompt.ts";
import type { SessionFacts } from "../../../contracts/src/prompt.ts";
import type { FactProvider, SessionSpawnContext } from "../ports/FactProvider.ts";
import type { PromptRegistry } from "../services/PromptRegistry.ts";
import type { PromptService } from "../services/PromptService.ts";
import { composePrompt } from "../services/prompt-compose.ts";
import { selectFragments } from "../services/fragment-select.ts";

export interface AssembleDeps {
  factProviders: FactProvider[];
  registry: PromptRegistry;
  prompts: PromptService;
}

export interface AssembleResult {
  text: string;
  facts: SessionFacts;
  activeFragmentIds: string[];
}

export async function assembleSystemPrompt(
  deps: AssembleDeps,
  ctx: SessionSpawnContext,
): Promise<AssembleResult> {
  deps.registry.reload(); // fresh read so prompt edits apply on the next spawn
  const facts = await gatherFacts(deps.factProviders, ctx);
  const vars = sessionVars(ctx);

  const selected = selectFragments(deps.registry.fragments(), facts);
  const rendered: string[] = [];
  for (const fragment of selected) {
    rendered.push(await deps.prompts.render(fragment.prompt.id, {}, { vars, cwd: ctx.cwd }));
  }

  return {
    text: composePrompt(rendered),
    facts,
    activeFragmentIds: selected.map((f) => f.prompt.id),
  };
}

async function gatherFacts(providers: FactProvider[], ctx: SessionSpawnContext): Promise<SessionFacts> {
  // Base derived from what the daemon already knows. Providers override the
  // world-derived facts (isGitRepo, os, shell); whatever a provider omits keeps
  // its conservative base value (fail-safe — unknown never invents git prose).
  const merged: Record<string, unknown> = {
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
  };
  for (const provider of providers) {
    Object.assign(merged, await provider.gather(ctx));
  }
  return SessionFactsSchema.parse(merged);
}

// The session's interpolation variables — UPPER_SNAKE, sourced from the spawn
// context. Fragments reference these (e.g. {{BRANCH}}, {{AGENT_NAME}}).
function sessionVars(ctx: SessionSpawnContext): Record<string, unknown> {
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
  };
}
