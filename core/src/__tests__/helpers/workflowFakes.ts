// Shared fakes for the workflow executor/engine tests: deterministic clock/ids,
// in-memory run/step repos, a programmable spawn port, a progress recorder, and a
// `buildEngine` that wires the REAL engine + the REAL built-in executors against
// them. Not a `*.test.ts` file, so the test glob never runs it directly.

import { WorkflowEngineImpl, type WorkflowEngineDeps } from "../../workflow/engine.ts";
import { InMemoryStepExecutorRegistry } from "../../workflow/registry.ts";
import { registerBuiltinExecutors } from "../../workflow/register-builtins.ts";
import { SCHEMA_INSTRUCTION, STEP_REPORT_INSTRUCTION } from "../../workflow/executors/step.ts";
import type { TransformFnRegistry } from "../../workflow/transforms.ts";
import type { SpawnStepSpec, StepOutcome, ExpertSpawnSpec } from "../../ports/WorkerSpawnPort.ts";
import type {
  WorkflowRun, WorkflowStep, WorkflowRunStatus, StepStatus,
} from "../../../../contracts/src/workflow.ts";

export function fakeClock() {
  let t = 1000;
  return { now: () => t++ };
}

export function fakeIds() {
  let n = 0;
  const mk = () => `id-${++n}`;
  return { newWorkerId: mk, newOrchestratorId: mk, newPendingId: mk, newRequestId: mk, newLoopId: mk };
}

export const noopLog = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return noopLog; },
};

export function runRepo() {
  const rows = new Map<string, WorkflowRun>();
  return {
    rows,
    insert(row: WorkflowRun) { rows.set(row.id, { ...row }); },
    findById(id: string) { return rows.get(id) ?? null; },
    listActive() { return [...rows.values()].filter((r) => r.status === "pending" || r.status === "running"); },
    listByOwner(ownerId: string) { return [...rows.values()].filter((r) => r.owner === ownerId); },
    setStatus(id: string, status: WorkflowRunStatus) { const r = rows.get(id); if (r) r.status = status; },
    setResult(id: string, result: unknown) { const r = rows.get(id); if (r) r.result = result; },
  };
}

export function stepRepo() {
  const rows = new Map<string, WorkflowStep>();
  const key = (runId: string, nodeId: string) => `${runId}:${nodeId}`;
  return {
    rows,
    upsert(row: WorkflowStep) { rows.set(key(row.runId, row.nodeId), { ...row }); },
    listByRun(runId: string) { return [...rows.values()].filter((r) => r.runId === runId); },
    findByNode(runId: string, nodeId: string) { return rows.get(key(runId, nodeId)) ?? null; },
    setStatus(runId: string, nodeId: string, status: StepStatus) { const r = rows.get(key(runId, nodeId)); if (r) r.status = status; },
    setOutput(runId: string, nodeId: string, output: unknown) { const r = rows.get(key(runId, nodeId)); if (r) r.output = output; },
    setWorker(runId: string, nodeId: string, workerId: string) { const r = rows.get(key(runId, nodeId)); if (r) r.workerId = workerId; },
  };
}

// A response a programmable spawn returns for one call. Returning nothing ⇒ echo
// the (binding-resolved) prompt BODY as the report text (the step output) — the
// executor-appended instructions are stripped so the echo mirrors prior behavior.
// `respond`
// MAY return a never/late-resolving promise (to test overlap) or throw (to
// simulate a crashed worker → spawnAndAwait rejects). For a typed step, set
// `reportText` to a ```json block (see `jsonReport`) so the engine extractor
// recovers a structured output.
export interface SpawnResponse {
  signal?: StepOutcome["signal"];
  reportText?: string;
}

// Encodes a value as the fenced ```json block a typed step's report carries, so
// the engine's extractJson recovers it. Pairs with a node `outputSchema`.
export function jsonReport(value: unknown): string {
  return "```json\n" + JSON.stringify(value) + "\n```";
}

// Strip the executor-appended instructions (the step-report contract + the schema
// suffix) so a test can assert on / echo the binding-resolved prompt BODY — the
// part data-flow tests care about. The step executor now appends
// STEP_REPORT_INSTRUCTION to every prompt (and SCHEMA_INSTRUCTION when typed).
export function promptBody(prompt: string): string {
  return prompt.split(STEP_REPORT_INSTRUCTION)[0].split(SCHEMA_INSTRUCTION)[0];
}

// A duck-typed schema that accepts ANY extracted JSON. The code-DSL path carries
// a live Zod schema; tests that only need the extract→parse→bind flow exercised
// use this so the parsed value passes straight through as the step output.
export const passSchema = {
  safeParse: (v: unknown): { success: true; data: unknown } => ({ success: true, data: v }),
};
export type Respond = (_spec: SpawnStepSpec, _index: number) => SpawnResponse | void | Promise<SpawnResponse | void>;

export function spawnPort(respond?: Respond) {
  const calls = {
    anchors: [] as Array<{ runId: string; ownerId: string; mode: string }>,
    experts: [] as ExpertSpawnSpec[],
    steps: [] as Array<SpawnStepSpec & { workerId: string }>,
    killed: [] as string[],
    // A single cross-surface ordering log: "anchor:<id>" / "expert:<name>" /
    // "step:<nodeId>" / "kill:<id>" pushed at each call so a test can assert the
    // run lifecycle (experts BEFORE steps, anchor kill in the finally — §3.5/§4).
    order: [] as string[],
  };
  let w = 0;
  return {
    calls,
    mintRunAnchor(runId: string, ownerId: string, mode: string) {
      calls.anchors.push({ runId, ownerId, mode });
      calls.order.push(`anchor:${runId}`);
      return runId;
    },
    async spawnExpert(spec: ExpertSpawnSpec) {
      calls.experts.push(spec);
      calls.order.push(`expert:${spec.name}`);
      return { workerId: `expert-${++w}` };
    },
    async spawnAndAwait(spec: SpawnStepSpec, signal: AbortSignal): Promise<StepOutcome> {
      // Abort BEFORE recording — the real adapter throws ahead of runSpawn, so an
      // aborted run spawns NO new worker (a composite mid-fan-out stops here).
      if (signal?.aborted) throw new Error("workflow run aborted");
      const workerId = `w-${++w}`;
      const index = calls.steps.length;
      calls.steps.push({ ...spec, workerId });
      calls.order.push(`step:${spec.nodeId}`);
      // The terminal outcome — the (possibly late/never-resolving) respond.
      const outcome = (async (): Promise<StepOutcome> => {
        const r = (respond ? await respond(spec, index) : undefined) ?? {};
        return {
          workerId,
          signal: r.signal ?? "result",
          reportText: r.reportText ?? promptBody(spec.prompt),
        };
      })();
      // Settle on the outcome OR on abort, whichever lands first; a settle after
      // the promise resolved is a safe no-op (mirrors the real adapter's join
      // rejecting an in-flight step when the run's signal aborts — §3.8).
      return new Promise<StepOutcome>((resolve, reject) => {
        outcome.then(resolve, reject);
        signal?.addEventListener("abort", () => reject(new Error("workflow run aborted")), { once: true });
      });
    },
    killWorker(workerId: string) {
      calls.killed.push(workerId);
      calls.order.push(`kill:${workerId}`);
    },
  };
}

export function progressSink() {
  const runs: Array<{ runId: string; status: WorkflowRunStatus }> = [];
  const steps: Array<{ nodeId: string; status: StepStatus }> = [];
  return {
    runs, steps,
    runChanged(runId: string, status: WorkflowRunStatus) { runs.push({ runId, status }); },
    stepChanged(_runId: string, nodeId: string, status: StepStatus) { steps.push({ nodeId, status }); },
  };
}

export function buildEngine(
  spawn: ReturnType<typeof spawnPort>,
  over: Partial<WorkflowEngineDeps> = {},
): {
  engine: WorkflowEngineImpl;
  deps: WorkflowEngineDeps;
  transforms: TransformFnRegistry;
} {
  const registry = new InMemoryStepExecutorRegistry();
  const { transforms } = registerBuiltinExecutors(registry);
  const deps: WorkflowEngineDeps = {
    registry,
    runs: runRepo(),
    steps: stepRepo(),
    spawn,
    progress: progressSink(),
    clock: fakeClock(),
    ids: fakeIds(),
    log: noopLog,
    maxConcurrentSteps: 16,
    ...over,
  };
  return { engine: new WorkflowEngineImpl(deps), deps, transforms };
}

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
