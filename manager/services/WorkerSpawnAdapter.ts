// WorkerSpawnAdapter — the manager-side implementation of the core WorkerSpawnPort
// (§3.5). It bridges the deterministic engine (which awaits ONE typed StepOutcome
// per leaf step) to Eos's async, fire-and-forget spawn surface:
//
//   spawnAndAwait → spawnWorkerHandler.run(...) (so `from`-definition / tool-scope /
//   mode / backend resolution come for free) → register a PendingJoin keyed by the
//   new worker id → settle it from ONE shared EventBus subscription.
//
// The join settles on:
//   • worker:report  → resolve with the report text + classifyReport() signal, but
//                      ONLY a RELEASED report (a held:true report is ignored — we
//                      wait for the loop-goal release; §2.3/§3.4).
//   • step-output    → resolveStepOutput() (the typed path) durably persists
//                      workflow_steps then resolves with the typed object (§3.6/§3.7).
//   • worker:exit    → reject IFF no report for that worker was seen first (a
//                      persistent worker reports and keeps living; exit-without-
//                      report = crash = failure). The synthetic run anchor's own
//                      exit is filtered by id so it never settles a step.
// First settle wins (resolve-once): the entry is deleted on the first of these, so
// any later report/exit for the same worker is a no-op.

import { classifyReport } from "../../core/src/domain/report-signal.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { WorkflowStepRepo } from "../../core/src/ports/WorkflowStepRepo.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type {
  WorkerSpawnPort, SpawnStepSpec, StepOutcome, ExpertSpawnSpec,
} from "../../core/src/ports/WorkerSpawnPort.ts";
import type { SpawnWorkerRequest } from "../../contracts/src/http.ts";
import type { PermissionMode } from "../../contracts/src/worker.ts";

// The body handed to spawnWorkerHandler.run. It is a SpawnWorkerRequest plus the
// `persistent` flag the handler forwards from the body onto the spawn spec — the
// request schema omits `persistent` (it is normally a worker-definition default),
// but run() is invoked directly here, not through schema validation, and threads
// any extra body field onto the spec via its `...bodyRest`.
export type StepSpawnRequest = SpawnWorkerRequest & { persistent?: boolean };

export interface WorkerSpawnAdapterDeps {
  bus: EventBus;
  steps: WorkflowStepRepo;
  workers: Pick<WorkerRepo, "insert">;
  clock: Clock;
  // Spawn one worker through the command handler; resolves to the new worker id.
  // Wired in the container phase to spawnWorkerHandler.run(NoAddr, req, { c, … }).
  runSpawn(req: StepSpawnRequest): Promise<{ id: string }>;
  // Recursive subtree teardown (the KillWorker use-case). Wired with container deps.
  killWorker(workerId: string): void;
}

interface PendingJoin {
  runId: string;
  nodeId: string;
  // Set on ANY report for this worker (held or released). Gates the exit-reject:
  // a worker that already reported (even held) did not crash, so its later exit
  // must not be turned into a failure.
  sawReport: boolean;
  resolve(outcome: StepOutcome): void;
  reject(err: Error): void;
}

// The anchor never runs a real backend (it is a synthetic row, reconciled to DONE
// on boot — §3.5). The kind is cosmetic; claude-sdk is the default lane.
const ANCHOR_BACKEND_KIND = "claude-sdk";

function readWorkerId(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const id = (payload as { workerId?: unknown }).workerId;
    if (typeof id === "string") return id;
  }
  return null;
}

function readReportText(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

function readHeld(payload: unknown): boolean {
  return !!(payload && typeof payload === "object" && (payload as { held?: unknown }).held === true);
}

export class WorkerSpawnAdapter implements WorkerSpawnPort {
  private readonly deps: WorkerSpawnAdapterDeps;
  private readonly joins = new Map<string, PendingJoin>();
  // Anchor ids minted by this adapter — their own worker:exit never settles a step.
  private readonly anchors = new Set<string>();
  private readonly unsubs: Array<() => void> = [];

  constructor(deps: WorkerSpawnAdapterDeps) {
    this.deps = deps;
    // ONE shared subscription for every PendingJoin (not one per spawn).
    this.unsubs.push(deps.bus.subscribe("worker:report", (m) => this.onReport(m.payload)));
    this.unsubs.push(deps.bus.subscribe("worker:exit", (m) => this.onExit(m.payload)));
  }

  stop(): void {
    for (const unsub of this.unsubs) {
      try { unsub(); } catch { /* best-effort */ }
    }
    this.unsubs.length = 0;
  }

  async spawnAndAwait(spec: SpawnStepSpec, signal: AbortSignal): Promise<StepOutcome> {
    if (signal.aborted) throw new Error("workflow run aborted before step spawn");
    const { id } = await this.deps.runSpawn(this.stepRequest(spec));
    // Stamp the worker id onto the (already-`running`) step row the instant we
    // know it, BEFORE the report can land. A crash in the await window then leaves
    // a `running` row durably linked to its worker, so the boot re-arm can match a
    // recovered `worker_report` against the node instead of re-spawning it (§3.7).
    this.deps.steps.setWorker(spec.runId, spec.nodeId, id);
    return new Promise<StepOutcome>((resolve, reject) => {
      const onAbort = (): void => {
        const entry = this.joins.get(id);
        if (!entry) return;
        this.joins.delete(id);
        this.deps.killWorker(id); // best-effort reap of the in-flight step worker
        entry.reject(new Error("workflow run aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      this.joins.set(id, {
        runId: spec.runId,
        nodeId: spec.nodeId,
        sawReport: false,
        resolve: (o) => { cleanup(); resolve(o); },
        reject: (e) => { cleanup(); reject(e); },
      });
    });
  }

  // The typed path (§3.6): the step-output route calls this when a worker POSTs
  // submit_step_output. Persist DURABLY before resolving so the completion
  // survives a crash in the window before the engine's own post-step journal
  // write (§3.7), then settle the join with the typed object. Idempotent: an
  // already-settled / unknown worker is a no-op.
  resolveStepOutput(workerId: string, output: unknown): void {
    const entry = this.joins.get(workerId);
    if (!entry) return;
    this.deps.steps.setOutput(entry.runId, entry.nodeId, output);
    this.deps.steps.setStatus(entry.runId, entry.nodeId, "passed");
    this.joins.delete(workerId);
    entry.resolve({ workerId, signal: "result", reportText: "", output });
  }

  async spawnExpert(spec: ExpertSpawnSpec): Promise<{ workerId: string }> {
    const { id } = await this.deps.runSpawn({
      from: spec.from,
      prompt: spec.prompt,
      model: spec.model,
      effort: spec.effort,
      name: spec.name, // expert id → peer-name slug
      parentId: spec.parentId, // = anchorId
      permissionMode: spec.mode as PermissionMode, // explicit — sidesteps inheritance
      collaborate: true,
      persistent: true, // standing IDLE-but-consultable mesh provider
      withGateway: true,
    });
    return { workerId: id };
  }

  killWorker(workerId: string): void {
    this.deps.killWorker(workerId);
  }

  // mode is set EXPLICITLY on every expert/step spawn, so the anchor row is never
  // consulted for permission-mode inheritance (§3.5) — the param is accepted for
  // the port contract but intentionally unused here.
  mintRunAnchor(runId: string, ownerId: string, _mode: string): string {
    this.deps.workers.insert({
      id: runId,
      prompt: "[workflow-run anchor]",
      cwd: null,
      worktreeFrom: null,
      branch: null,
      name: null,
      nameSource: "user", // never auto-named — it has no turn
      pid: null,
      port: 0,
      startedAt: this.deps.clock.now(),
      parentId: ownerId, // orchestrator selfId — preserves ownership + the inheritance chain
      model: "",
      effort: null,
      isOrchestrator: true,
      backendKind: ANCHOR_BACKEND_KIND,
      backendProfile: null,
      agentRole: null,
      workerDefinition: null,
      toolScope: null,
      withGateway: false,
      collaborate: false,
      worktreeDir: null,
      workspaceOwnerId: null,
      workspaceReady: false,
    });
    this.anchors.add(runId);
    return runId;
  }

  private stepRequest(spec: SpawnStepSpec): StepSpawnRequest {
    // No cwd/worktreeFrom: SpawnStepSpec carries none — the runSpawn wiring
    // injects the run's working directory at the composition root.
    return {
      from: spec.from,
      prompt: spec.prompt,
      model: spec.model,
      effort: spec.effort,
      toolsAllow: spec.toolsAllow,
      toolsDeny: spec.toolsDeny,
      parentId: spec.parentId, // = anchorId
      permissionMode: spec.mode as PermissionMode, // explicit — sidesteps inheritance
      collaborate: spec.collaborate,
      withGateway: true,
    };
  }

  private onReport(payload: unknown): void {
    const workerId = readWorkerId(payload);
    if (!workerId) return;
    const entry = this.joins.get(workerId);
    if (!entry) return;
    entry.sawReport = true;
    if (readHeld(payload)) return; // held — not the terminal; wait for the release
    const reportText = readReportText(payload);
    this.joins.delete(workerId);
    entry.resolve({ workerId, signal: classifyReport(reportText), reportText, output: undefined });
  }

  private onExit(payload: unknown): void {
    const workerId = readWorkerId(payload);
    if (!workerId) return;
    if (this.anchors.has(workerId)) return; // the anchor's own exit never settles a step
    const entry = this.joins.get(workerId);
    if (!entry) return;
    if (entry.sawReport) return; // reported (held) then died — keep waiting for the release
    this.joins.delete(workerId);
    entry.reject(new Error(`step worker ${workerId} exited before reporting`));
  }
}
