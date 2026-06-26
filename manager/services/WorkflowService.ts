// WorkflowService — the daemon-resident driver for the workflow-orchestration
// system (§3.1). A sibling of GoalLoopService: NOT an agent, just plain
// TypeScript in the daemon that the single MCP `workflow` tool triggers. It owns
// the per-run AbortController registry (the stop/abort handle — §3.8) and threads
// the run-level concerns the core engine needs but the persisted run row does not
// carry (owner, permission mode, signal), resolving config/mode at this manager
// boundary so core never reads config (the loops.ts → attachLoop pattern).

import { runWorkflow } from "../../core/src/use-cases/RunWorkflow.ts";
import { resumeWorkflow } from "../../core/src/use-cases/ResumeWorkflow.ts";
import { stopWorkflow } from "../../core/src/use-cases/StopWorkflow.ts";
import { createWorkflowDefinition } from "../../core/src/use-cases/CreateWorkflowDefinition.ts";
import { WorkflowDefinitionSchema } from "../../contracts/src/workflow.ts";
import { containsNodeType } from "../../core/src/workflow/node-scope.ts";
import { attachOutputValidators } from "./json-schema-validator.ts";
import { NotFoundError, ValidationError } from "../../core/src/errors/index.ts";
import type {
  WorkflowDefinition, WorkflowRunStatus, RunWorkflowResult,
} from "../../contracts/src/workflow.ts";
import type { WorkflowEngine, WorkflowRunResult } from "../../core/src/ports/WorkflowEngine.ts";
import type { WorkflowRunRepo } from "../../core/src/ports/WorkflowRunRepo.ts";
import type { WorkerSpawnPort } from "../../core/src/ports/WorkerSpawnPort.ts";
import type { ProgressSink } from "../../core/src/ports/ProgressSink.ts";
import type { RuntimeWorkflowDefinitionStore } from "../../core/src/ports/RuntimeWorkflowDefinitionStore.ts";
import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

export interface WorkflowServiceDeps {
  engine: WorkflowEngine;
  runs: WorkflowRunRepo;
  spawn: WorkerSpawnPort;             // killWorker(anchorId) reaps the subtree on stop
  progress: ProgressSink;
  definitions: RuntimeWorkflowDefinitionStore;   // create() persists per-owner
  // Overlay resolver (builtin → file → runtime), supplied by the container.
  resolveDefinition(name: string, ownerId: string): WorkflowDefinition | null;
  // The run permission mode, set EXPLICITLY on every spawn (§3.5). The manager
  // resolves it from the owning orchestrator; core never reads it.
  resolveMode(ownerId: string): string;
  // On completion (passed OR failed), deliver the FULL result to the run owner as
  // a directed message (§ITEM 8) — the manager holds both the result and
  // dispatchMessage, so no core port. NOT called on user-stop/abort: the run
  // promise rejects and hits .catch instead (the operator already knows).
  deliverCompletion(ownerId: string, result: WorkflowRunResult): void;
  ids: IdGenerator;
  log: Logger;
}

export interface RunWorkflowArgs {
  from?: string;
  spec?: WorkflowDefinition;
  args?: unknown;
}

export class WorkflowService {
  private readonly deps: WorkflowServiceDeps;
  // One AbortController per in-flight run — the stop/kill handle (§3.8).
  private readonly controllers = new Map<string, AbortController>();

  constructor(deps: WorkflowServiceDeps) {
    this.deps = deps;
  }

  // Start a run and return immediately — the engine drives the tree in the
  // background (like spawn_worker, the tool call never blocks for completion).
  // engine.run's synchronous prefix mints the anchor + inserts the run row before
  // this returns, so a follow-up status() can never race a missing row.
  run(input: RunWorkflowArgs, ownerId: string): RunWorkflowResult {
    if (input.spec) {
      WorkflowDefinitionSchema.parse(input.spec);   // fail loud on a malformed inline spec
      // Trust gate (§ITEM 1c): a `script` node runs a local script, so it is
      // allowed ONLY from a trusted stored/builtin/file definition — NEVER from an
      // LLM-emitted run-inline spec, which would reintroduce arbitrary code-exec.
      if (containsNodeType(input.spec.root, "script")) {
        throw new ValidationError(
          "run-inline specs may not contain `script` nodes; create the workflow and run it by name (run-stored)",
        );
      }
      // Honor a declared JSON-Schema `outputSchema`: a run-inline spec carries it as
      // a plain object the pure-core executor can't validate, so wrap it into the
      // executor's ZodLike { safeParse } duck-type here (§Issue B) — restores typed
      // step I/O for orchestrator-authored workflows.
      attachOutputValidators(input.spec.root);
    } else if (input.from) {
      if (!this.deps.resolveDefinition(input.from, ownerId)) {
        throw new NotFoundError("workflow definition", input.from);
      }
    } else {
      throw new ValidationError("workflow run requires `from` or `spec`");
    }

    const runId = this.deps.ids.newWorkerId();   // = the synthetic anchor row id (§3.5)
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const mode = this.deps.resolveMode(ownerId);

    // Fire-and-forget: the long-running tree drive self-handles its own failure.
    void runWorkflow(
      { engine: this.deps.engine, resolveDefinition: this.deps.resolveDefinition },
      { runId, ownerId, mode, signal: controller.signal, from: input.from, spec: input.spec, args: input.args },
    )
      .then((result) => this.deps.deliverCompletion(ownerId, result))   // passed AND failed
      .catch((e) => this.deps.log.warn("workflow run failed", { runId, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.controllers.delete(runId));

    return { runId, status: "running" };
  }

  // Boot re-arm (reArmWorkflows) re-drives an interrupted run: reconstruct the
  // RunContext and replay through engine.resume — journaled `passed` steps replay
  // their memoized output without re-spawning; the first un-journaled node runs
  // live. Returns the engine promise so the caller (reArmWorkflows) owns error
  // handling and may await for determinism; the daemon voids it so boot never
  // blocks on a run's completion.
  resume(runId: string): Promise<WorkflowRunResult> {
    const row = this.deps.runs.findById(runId);
    if (!row) throw new NotFoundError("workflow run", runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const mode = this.deps.resolveMode(row.owner);
    return resumeWorkflow(
      { engine: this.deps.engine },
      { runId, ownerId: row.owner, mode, signal: controller.signal },
    )
      .then((result) => { this.deps.deliverCompletion(row.owner, result); return result; })
      .finally(() => this.controllers.delete(runId));
  }

  // The lean run view the `workflow` tool's status mode returns (the full row is
  // read via GET /workflows/:id).
  status(runId: string): RunWorkflowResult {
    const row = this.deps.runs.findById(runId);
    if (!row) throw new NotFoundError("workflow run", runId);
    return { runId: row.id, status: row.status, output: row.result };
  }

  // Stop (§3.8): status → stopped, abort the run's signal so in-flight composites
  // stop spawning new children, then reap the whole anchor subtree (experts +
  // step-workers). The join's worker:exit subscription rejects any in-flight
  // spawnAndAwait cleanly. Idempotent: an already-terminal run is returned as-is.
  stop(runId: string): { runId: string; status: WorkflowRunStatus } {
    const row = this.deps.runs.findById(runId);
    return stopWorkflow(
      { runs: this.deps.runs, progress: this.deps.progress },
      {
        runId,
        abort: () => {
          this.controllers.get(runId)?.abort();
          this.controllers.delete(runId);
          if (row) this.deps.spawn.killWorker(row.anchorId);
        },
      },
    );
  }

  // create_workflow: validate + persist a per-owner runtime definition for reuse.
  create(spec: WorkflowDefinition, ownerId: string): { name: string } {
    return createWorkflowDefinition({ store: this.deps.definitions }, { ownerId, spec });
  }
}
