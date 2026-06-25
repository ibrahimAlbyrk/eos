// WorkerSpawnPort — the narrow seam the leaf step depends on (§3.5). The manager
// adapter (WorkerSpawnAdapter) does the real work: `spawnAndAwait` runs
// `spawnWorkerHandler.run(...)` (so `from`-definition / tool-scope / mode /
// backend resolution come for free) then registers a PendingJoin that resolves on
// the matching `worker:report` and rejects on a `worker:exit` with no prior
// report. `spawnExpert` spawns a standing persistent+collaborate mesh provider
// under the anchor. `mintRunAnchor` inserts the synthetic anchor worker-row that
// scopes the run's mesh and enables one-call subtree teardown via `killWorker`.

// What a leaf `step` asks the spawn surface to run. `parentId` is the run anchor;
// `mode` is set EXPLICITLY on every spawn so the engine never depends on the
// anchor row for permission-mode inheritance (§3.5). `collaborate:true` so the
// step-worker can consult the expert pool while it works.
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
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly toolsAllow?: string[];
  readonly toolsDeny?: string[];
  readonly mode: string;              // explicit — sidesteps inheritance
  readonly collaborate: boolean;      // true so steps can consult experts
  readonly outputSchema?: unknown;    // when set, the final report must carry a
                                      // matching ```json block (extracted engine-side)
}

// The terminal outcome of a step-worker: the parsed report signal
// (classifyReport()) and the raw report text. The report text IS the step's
// output (§3.6); a typed step extracts + validates JSON from it engine-side.
export interface StepOutcome {
  readonly workerId: string;
  readonly signal: "result" | "needs-input" | "failed" | "unknown";
  readonly reportText: string;
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
  mintRunAnchor(runId: string, ownerId: string, mode: string): string;
}
