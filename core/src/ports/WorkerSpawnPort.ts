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
                                      // PendingJoin carries it so a typed step-output can
                                      // persist workflow_steps durably (§3.6/§3.7).
  readonly parentId: string;          // = anchorId
  readonly from?: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly toolsAllow?: string[];
  readonly toolsDeny?: string[];
  readonly mode: string;              // explicit — sidesteps inheritance
  readonly collaborate: boolean;      // true so steps can consult experts
  readonly outputSchema?: unknown;    // when set, await submit_step_output
}

// The terminal outcome of a step-worker: the parsed report signal
// (classifyReport()), the raw report text, and — only when the worker used
// submit_step_output — the typed `output` object.
export interface StepOutcome {
  readonly workerId: string;
  readonly signal: "result" | "needs-input" | "failed" | "unknown";
  readonly reportText: string;
  readonly output?: unknown;
}

// A standing expert: spawned once at run start, persistent + collaborate, kept
// IDLE-but-consultable under the anchor. `name` (the expert's stable id) becomes
// its peer-name slug, so step-workers consult it by name (§4).
export interface ExpertSpawnSpec {
  readonly runId: string;
  readonly parentId: string;          // = anchorId
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
