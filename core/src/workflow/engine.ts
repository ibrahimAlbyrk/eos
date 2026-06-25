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
  // How resume() reconstructs a stored run's tree (the run row carries only the
  // definition NAME, not the spec). The manager supplies the definition-overlay
  // resolver; absent ⇒ resume of a named run throws a clear error.
  resolveDefinition?: (name: string, ownerId: string) => WorkflowDefinition | null;
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

    const result = await this.deps.registry.get(node.type).execute(node, ctx);

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

  // --- per-run lifecycle: fresh run ---
  async run(def: WorkflowDefinition, args: unknown, ctx: RunContext): Promise<WorkflowRunResult> {
    const anchorId = this.deps.spawn.mintRunAnchor(ctx.runId, ctx.ownerId, ctx.mode);
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
    const resumeCtx: RunContext = { runId, ownerId: row.owner, mode: ctx.mode, signal: ctx.signal };
    return this.execute(def, row.args, resumeCtx, row.anchorId);
  }

  // The shared body run() and resume() both run: spawn experts → walk root →
  // persist result, with a guaranteed teardown of the whole anchor subtree.
  private async execute(def: WorkflowDefinition, args: unknown, ctx: RunContext, anchorId: string): Promise<WorkflowRunResult> {
    try {
      for (const e of def.experts ?? []) {
        await this.deps.spawn.spawnExpert({
          runId: ctx.runId, parentId: anchorId, definitionOwnerId: ctx.ownerId,
          name: e.id, from: e.from, prompt: e.prompt,
          model: e.model, effort: e.effort, mode: ctx.mode, persistent: true, collaborate: true,
        });
      }

      const execCtx: WorkflowExecCtx = {
        runId: ctx.runId,
        anchorId,
        ownerId: ctx.ownerId,
        mode: ctx.mode,
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

      const result = await this.runNode(def.root, execCtx);
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
