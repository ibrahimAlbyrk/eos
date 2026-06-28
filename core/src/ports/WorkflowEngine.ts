// WorkflowEngine — the Interpreter entrypoint (§3.13). `run` owns the per-run
// Template-Method lifecycle (mint anchor → insert run → spawn experts → runNode →
// persist result → finally teardown); `resume` runs the SAME try/finally with
// memoized replay (a journaled `passed` step replays its output instead of
// re-spawning). Extending NodeRunner makes the engine the recursion target that
// composite executors drive their children through. The pure impl is
// WorkflowEngineImpl in core/src/workflow/engine.ts.

import type { WorkflowDefinition, WorkflowRunStatus } from "../../../contracts/src/workflow.ts";
import type { WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { NodeRunner } from "./StepExecutor.ts";

// What a run needs that the persisted run row does not carry: the freshly-minted
// runId, the owning orchestrator, the permission mode (set explicitly on every
// spawn), and the run-level AbortSignal (stop/kill propagation — C6).
export interface RunContext {
  readonly runId: string;
  readonly ownerId: string;
  readonly mode: string;
  readonly signal?: AbortSignal;
  // The orchestrator's working directory at run launch (mirrors spawn_worker's
  // worktreeFrom = ctx.cwd). Threaded onto every step/expert spawn as
  // worktreeFrom, so a run's workers start in the owner's path, not repoRoot.
  // Absent ⇒ the spawn falls back to repoRoot at the composition root.
  readonly cwd?: string;
}

export interface WorkflowRunResult {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly output: unknown;
}

export interface WorkflowEngine extends NodeRunner {
  // `def` is a v1 tree or a v2 graph — the engine compiles a tree into the graph
  // runtime at run start and runs a graph directly (A4 Option C).
  run(def: WorkflowDefinition | WorkflowGraph, args: unknown, ctx: RunContext): Promise<WorkflowRunResult>;
  resume(runId: string, ctx: RunContext): Promise<WorkflowRunResult>;
}
