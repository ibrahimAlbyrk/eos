// engine.ts — the daemon-resident interpreter (§3.1/§4.4). Two roles compose:
//
//  • runNode — the Template-Method skeleton every node passes through, so the
//    cross-cutting concerns live in ONE place and executors stay dumb:
//      resolve-from-journal (memo-check) → journal start → execute → journal
//      result → publish progress. It NEVER branches on node.type; it dispatches
//      to registry.get(type).execute and lets composites recurse via ctx.engine.
//
//  • run / resume — the per-run lifecycle: mint the synthetic anchor row, insert
//    the run, spawn the standing experts (persistent + collaborate under the
//    anchor), walk the root, persist the result, and ALWAYS reap the anchor
//    subtree in a `finally` (the teardown guarantee — experts never leak). resume
//    shares that exact try/finally; the step journal makes a `passed` node replay
//    its output instead of re-spawning (memoized replay).
//
// Determinism (C5): the only time/identity sources are the injected Clock/
// IdGenerator ports — no Date.now / Math.random anywhere. The concrete executors
// are a LATER phase: this skeleton compiles against the StepExecutor interface +
// registry.get() lookup and imports no concrete executor.

import type { WorkflowDefinition, WorkflowRunStatus } from "../../../contracts/src/workflow.ts";
import type { WorkflowGraph, AnyWorkflowDefinition } from "../../../contracts/src/workflow-graph.ts";
import type { WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type {
  WorkflowEngine, RunContext, WorkflowRunResult,
} from "../ports/WorkflowEngine.ts";
import type { NodeResult, WorkflowExecCtx } from "../ports/StepExecutor.ts";
import type { StepExecutorRegistry } from "../ports/StepExecutorRegistry.ts";
import type { WorkflowRunRepo } from "../ports/WorkflowRunRepo.ts";
import type { WorkflowStepRepo } from "../ports/WorkflowStepRepo.ts";
import type { WorkerSpawnPort } from "../ports/WorkerSpawnPort.ts";
import type { ProgressSink } from "../ports/ProgressSink.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { Logger } from "../ports/Logger.ts";
import { BindingScope } from "./bindings.ts";
import { CountingSemaphore } from "./concurrency.ts";
import { scheduleGraph, toGraph } from "./scheduler.ts";

export interface WorkflowEngineDeps {
  registry: StepExecutorRegistry;
  runs: WorkflowRunRepo;
  steps: WorkflowStepRepo;
  spawn: WorkerSpawnPort;
  progress: ProgressSink;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  // The per-run concurrency cap; the manager resolves it from
  // config.workflow.maxConcurrentSteps and injects the number (core never reads
  // config). A fresh semaphore is minted per run, shared by every child ctx.
  maxConcurrentSteps: number;
  // How resume() reconstructs a stored run's definition (the run row carries only
  // the definition NAME, not the spec). The manager supplies the definition-overlay
  // resolver; it may return a v1 tree OR a v2 graph. Absent ⇒ resume of a named run
  // throws a clear error.
  resolveDefinition?: (name: string, ownerId: string) => AnyWorkflowDefinition | null;
}

export class WorkflowEngineImpl implements WorkflowEngine {
  private readonly deps: WorkflowEngineDeps;

  constructor(deps: WorkflowEngineDeps) {
    this.deps = deps;
  }

  // --- the Template-Method skeleton (§3.11) -- every node passes through here ---
  async runNode(node: WorkflowNode, ctx: WorkflowExecCtx): Promise<NodeResult> {
    // memo-check: a journaled `passed` node replays its output (resume) instead
    // of re-spawning. Re-seed its binding so downstream refs still resolve.
    const journaled = this.deps.steps.findByNode(ctx.runId, node.id);
    if (journaled && journaled.status === "passed") {
      ctx.bindings.set(node.id, journaled.output);
      const replayWorker = journaled.workerId ?? undefined;
      this.deps.progress.stepChanged(ctx.runId, node.id, "passed", replayWorker);
      return { output: journaled.output, status: "passed", childWorkerIds: journaled.workerId ? [journaled.workerId] : undefined };
    }

    const startedAt = this.deps.clock.now();
    this.deps.steps.upsert({
      id: stepRowId(ctx.runId, node.id),
      runId: ctx.runId, nodeId: node.id, nodeType: node.type,
      status: "running", workerId: null, startedAt, endedAt: null,
    });
    this.deps.progress.stepChanged(ctx.runId, node.id, "running");

    let result: NodeResult;
    try {
      result = await this.deps.registry.get(node.type).execute(node, ctx);
    } catch (e) {
      // D3: execute() threw (an executor error) or rejected (a run-abort/stop
      // propagated to the in-flight spawn). The terminal upsert below is skipped,
      // so without this the 'running' row above would stay 'running' FOREVER — an
      // unfaithful journal that boot re-arm/resume read as still-in-flight. Settle
      // it `failed` (StepStatus has no `stopped`; failed is the terminal status an
      // errored/aborted node takes) before rethrowing. The rethrow is unchanged, so
      // whether the run soft-fails to a token or propagates-and-aborts is still
      // decided by the caller (scheduler.runLeaf) exactly as before.
      //
      // PRESERVE the stamped worker id: the spawn adapter set it on the `running`
      // row the instant it knew it (before the await that just threw), so an
      // in-flight step that crashes/aborts STAYS linked to its worker. Writing null
      // here would clobber it (the repo upsert does ON CONFLICT SET worker_id),
      // severing the failed step from its worker transcript + the workerId-keyed
      // re-arm trace window.
      const workerId = this.deps.steps.findByNode(ctx.runId, node.id)?.workerId ?? null;
      this.deps.steps.upsert({
        id: stepRowId(ctx.runId, node.id),
        runId: ctx.runId, nodeId: node.id, nodeType: node.type,
        status: "failed", workerId,
        output: { error: e instanceof Error ? e.message : String(e) },
        startedAt, endedAt: this.deps.clock.now(),
      });
      this.deps.progress.stepChanged(ctx.runId, node.id, "failed");
      throw e;
    }

    ctx.bindings.set(node.id, result.output);
    const workerId = result.childWorkerIds && result.childWorkerIds.length > 0 ? result.childWorkerIds[0] : null;
    this.deps.steps.upsert({
      id: stepRowId(ctx.runId, node.id),
      runId: ctx.runId, nodeId: node.id, nodeType: node.type,
      status: result.status, workerId, output: result.output,
      startedAt, endedAt: this.deps.clock.now(),
    });
    this.deps.progress.stepChanged(ctx.runId, node.id, result.status, workerId ?? undefined);
    return result;
  }

  // D4: journal a node that FAILED before runNode could ever create its row —
  // i.e. the scheduler rejected its input port-type values, so it returns a failed
  // token without dispatching the executor. Without this the failed node leaves NO
  // workflow_steps row at all (invisible to the journal + to resume). Writes a
  // terminal `failed` row carrying the validation error; the start/end timestamps
  // coincide because the node never actually ran. The run-level failure is produced
  // by the caller's failed Outcome, unchanged — this only makes the journal faithful.
  journalFailedNode(node: WorkflowNode, ctx: WorkflowExecCtx, output: unknown): void {
    const now = this.deps.clock.now();
    this.deps.steps.upsert({
      id: stepRowId(ctx.runId, node.id),
      runId: ctx.runId, nodeId: node.id, nodeType: node.type,
      status: "failed", workerId: null, output, startedAt: now, endedAt: now,
    });
    this.deps.progress.stepChanged(ctx.runId, node.id, "failed");
  }

  // --- per-run lifecycle: fresh run ---
  async run(def: WorkflowDefinition | WorkflowGraph, args: unknown, ctx: RunContext): Promise<WorkflowRunResult> {
    const anchorId = this.deps.spawn.mintRunAnchor(ctx.runId, ctx.ownerId, ctx.mode, ctx.cwd);
    const now = this.deps.clock.now();
    this.deps.runs.insert({
      id: ctx.runId, definitionName: def.name, owner: ctx.ownerId, anchorId,
      status: "running", args, startedAt: now, updatedAt: now,
    });
    this.deps.progress.runChanged(ctx.runId, "running");
    return this.execute(def, args, ctx, anchorId);
  }

  // --- per-run lifecycle: resume (memoized replay through the SAME try/finally) ---
  async resume(runId: string, ctx: RunContext): Promise<WorkflowRunResult> {
    const row = this.deps.runs.findById(runId);
    if (!row) throw new Error(`workflow run "${runId}" not found`);
    if (!row.definitionName) throw new Error(`workflow run "${runId}" was inline; inline runs are not resumable in v1`);
    if (!this.deps.resolveDefinition) throw new Error("resume requires a definition resolver");
    const def = this.deps.resolveDefinition(row.definitionName, row.owner);
    if (!def) throw new Error(`workflow definition "${row.definitionName}" not found for resume of "${runId}"`);

    this.deps.progress.runChanged(runId, "running");
    // The anchor is a synthetic ROW (persists across restarts); reuse it rather
    // than minting a new one. Experts re-spawn fresh — they are config, never
    // journaled (§4.3) — so their dead processes come back before the replay.
    // ctx.cwd is recovered from the persisted anchor row by the caller
    // (WorkflowService.resume) so a resumed run spawns steps in the run's path too.
    const resumeCtx: RunContext = { runId, ownerId: row.owner, mode: ctx.mode, signal: ctx.signal, cwd: ctx.cwd };
    return this.execute(def, row.args, resumeCtx, row.anchorId);
  }

  // The shared body run() and resume() both run: spawn experts → schedule the
  // graph → persist result, with a guaranteed teardown of the whole anchor subtree.
  // A v1 tree is compiled into a v2 graph here (treeToGraph); a v2 graph runs
  // directly — ONE runtime, both shapes (A4 Option C).
  private async execute(def: WorkflowDefinition | WorkflowGraph, args: unknown, ctx: RunContext, anchorId: string): Promise<WorkflowRunResult> {
    const graph = toGraph(def);
    try {
      for (const e of graph.experts ?? []) {
        await this.deps.spawn.spawnExpert({
          runId: ctx.runId, parentId: anchorId, definitionOwnerId: ctx.ownerId,
          name: e.id, from: e.from, worktreeFrom: ctx.cwd, prompt: e.prompt,
          model: e.model, effort: e.effort, mode: ctx.mode, persistent: true, collaborate: true,
        });
      }

      const execCtx: WorkflowExecCtx = {
        runId: ctx.runId,
        anchorId,
        ownerId: ctx.ownerId,
        mode: ctx.mode,
        cwd: ctx.cwd,
        args,
        bindings: new BindingScope(args),
        engine: this,
        spawn: this.deps.spawn,
        progress: this.deps.progress,
        clock: this.deps.clock,
        ids: this.deps.ids,
        log: this.deps.log,
        concurrency: new CountingSemaphore(this.deps.maxConcurrentSteps),
        signal: ctx.signal ?? new AbortController().signal,
        resolveDefinition: this.deps.resolveDefinition
          ? (name: string) => this.deps.resolveDefinition!(name, ctx.ownerId)
          : undefined,
      };

      const result = await scheduleGraph(graph, execCtx);
      const status: WorkflowRunStatus = result.status === "passed" ? "passed" : "failed";
      this.deps.runs.setStatus(ctx.runId, status);
      this.deps.runs.setResult(ctx.runId, result.output);
      this.deps.progress.runChanged(ctx.runId, status);
      return { runId: ctx.runId, status, output: result.output };
    } finally {
      // TEARDOWN — guaranteed on success, failure, and abort. Recursively reaps
      // the experts + every step-worker under the anchor in one call (§3.5).
      this.deps.spawn.killWorker(anchorId);
    }
  }
}

// The step row PK: deterministic in (runId, nodeId) so the start-upsert and the
// result-upsert address the same row, and findByNode(runId, nodeId) memoizes it.
function stepRowId(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}
