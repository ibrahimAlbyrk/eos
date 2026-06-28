// WorkerSpawnPort — the narrow seam the leaf step depends on (§3.5). The manager
// adapter (WorkerSpawnAdapter) does the real work: `spawnAndAwait` runs
// `spawnWorkerHandler.run(...)` (so `from`-definition / tool-scope / mode /
// backend resolution come for free) then registers a PendingJoin that resolves on
// the matching `worker:report` and rejects on a `worker:exit` with no prior
// report. `spawnExpert` spawns a standing persistent+collaborate mesh provider
// under the anchor. `mintRunAnchor` inserts the synthetic anchor worker-row that
// scopes the run's mesh and enables one-call subtree teardown via `killWorker`.

import type { SpawnLoop } from "../../../contracts/src/loop.ts";

// What a leaf `step` asks the spawn surface to run. `parentId` is the run anchor;
// `mode` is set EXPLICITLY on every spawn so the engine never depends on the
// anchor row for permission-mode inheritance (§3.5). `collaborate:false` — a
// workflow node is a deterministic step with no peer/expert mesh (Part B / D4).
export interface SpawnStepSpec {
  readonly runId: string;
  readonly nodeId: string;            // step PK is `${runId}:${nodeId}` — the adapter's
                                      // PendingJoin carries it so the step's completion
                                      // journals workflow_steps durably (§3.7).
  readonly parentId: string;          // = anchorId
  readonly definitionOwnerId: string; // = run owner; resolves the orchestrator's
                                      // create_worker runtime defs (the anchor id
                                      // is not the selfId, so parentId can't).
  readonly from?: string;
  readonly worktreeFrom?: string;     // the run owner's cwd — the step spawns in the
                                      // orchestrator's path (mirrors spawn_worker); absent
                                      // ⇒ repoRoot fallback at the composition root.
  readonly role?: string;             // DPI role — "workflow-worker" so the step
                                      // gets the node-specific prompt + tool surface.
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly toolsAllow?: string[];
  readonly toolsDeny?: string[];
  readonly mode: string;              // explicit — sidesteps inheritance
  readonly collaborate: boolean;      // false for workflow nodes (no peer/expert mesh)
  readonly outputSchema?: unknown;    // when set, validates the workflow_step_output
                                      // `output` arg directly (no prose scrape)
  readonly inputs?: Record<string, unknown>; // typed input-port values delivered by
                                      // the graph scheduler (Phase 3 / A5): the
                                      // structured payload the node received on its
                                      // edges, also interpolated into the prompt as
                                      // `{{in.<port>}}` — not a scraped string ref.
  readonly loop?: SpawnLoop;          // arm dynamic_loop at spawn → the worker
                                      // self-iterates; its output is HELD until the
                                      // goal-check releases it (the join awaits release)
}

// The terminal outcome of a step-worker: its self-declared status + the typed
// output it emitted via workflow_step_output (Part B). `done` binds `output` as
// the node result; `failed`/`needs-input` fail the node with `reason` surfaced.
export interface StepOutcome {
  readonly workerId: string;
  readonly status: "done" | "failed" | "needs-input";
  readonly output: unknown;
  readonly reason?: string;
}

// A standing expert: spawned once at run start, persistent + collaborate, kept
// IDLE-but-consultable under the anchor. `name` (the expert's stable id) becomes
// its peer-name slug, so step-workers consult it by name (§4).
export interface ExpertSpawnSpec {
  readonly runId: string;
  readonly parentId: string;          // = anchorId
  readonly definitionOwnerId: string; // = run owner; experts resolve the same
                                      // create_worker runtime defs as steps.
  readonly name: string;              // expert id → peer-name slug
  readonly from?: string;
  readonly worktreeFrom?: string;     // the run owner's cwd — experts spawn in the
                                      // orchestrator's path too; absent ⇒ repoRoot fallback.
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode: string;
  readonly persistent: boolean;
  readonly collaborate: boolean;
}

export interface WorkerSpawnPort {
  spawnAndAwait(spec: SpawnStepSpec, signal: AbortSignal): Promise<StepOutcome>;
  spawnExpert(spec: ExpertSpawnSpec): Promise<{ workerId: string }>;
  killWorker(workerId: string): void;
  // `cwd` (the run owner's working dir) is recorded on the anchor row so a boot
  // re-arm/resume can recover the run cwd and re-spawn steps in the same path.
  mintRunAnchor(runId: string, ownerId: string, mode: string, cwd?: string): string;
}
