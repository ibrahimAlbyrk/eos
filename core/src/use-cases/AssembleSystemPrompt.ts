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
import type { VariableScope } from "../domain/prompt.ts";
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
  // Absolute path to this orchestrator's rendered swarm playbook, exposed as
  // SWARM_PLAYBOOK_PATH so the decompose fragment can point at it. The daemon
  // renders the playbook to a per-spawn file (the orchestrator's cwd is the
  // user's project, not the Eos install, so it can't read the library source).
  // Absent/null for workers and when rendering was skipped → empty var.
  swarmPlaybookPath?: string | null;
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

export function assembleSystemPrompt(deps: AssembleDeps, ctx: SessionSpawnContext): AssembleResult {
  deps.registry.reload(); // fresh read so prompt edits apply on the next spawn
  const facts = deriveFacts(ctx);
  const vars = sessionVars(ctx);

  const selected = selectFragments(deps.registry.fragments(), facts);
  const rendered = selected.map((f) => deps.prompts.render(f.prompt.id, {}, vars));

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
    SWARM_PLAYBOOK_PATH: ctx.swarmPlaybookPath ?? "",
  };
}
