// StepExecutor — the Strategy (§3.11): ONE executor per node `type`, the
// Open/Closed unit. The interpreter (WorkflowEngine.runNode) looks up
// `registry.get(node.type)` and calls `execute`; it never branches on the type
// itself. Composite executors recurse through `ctx.engine` (the NodeRunner seam,
// DIP) so they never import the engine impl. Every cross-cutting concern (the
// spawn surface, progress, the concurrency gate, the run-scoped bindings, the
// determinism clock/ids) reaches the executor through WorkflowExecCtx.

import type { WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { BindingScope } from "../workflow/bindings.ts";
import type { WorkerSpawnPort } from "./WorkerSpawnPort.ts";
import type { ProgressSink } from "./ProgressSink.ts";
import type { ConcurrencyGate } from "./ConcurrencyGate.ts";
import type { Clock } from "./Clock.ts";
import type { IdGenerator } from "./IdGenerator.ts";
import type { Logger } from "./Logger.ts";

export interface NodeResult {
  readonly output: unknown;             // validated step output / aggregate of children
  readonly status: "passed" | "failed" | "skipped";
  readonly childWorkerIds?: string[];   // ownership / cleanup + UI
}

export interface StepExecutor<N extends WorkflowNode = WorkflowNode> {
  readonly type: N["type"];             // registry key
  execute(node: N, ctx: WorkflowExecCtx): Promise<NodeResult>;
}

// The recursion seam: composites drive their children through this, never
// through the concrete engine (DIP). The engine impl IS the NodeRunner.
export interface NodeRunner {
  runNode(node: WorkflowNode, ctx: WorkflowExecCtx): Promise<NodeResult>;
}

export interface WorkflowExecCtx {
  readonly runId: string;
  readonly anchorId: string;            // synthetic run anchor (parentId for every spawn) — §3.5
  readonly ownerId: string;             // run owner (orchestrator selfId) — resolves create_worker runtime defs
  readonly mode: string;                // run permission mode, set explicitly on every spawn
  readonly args: unknown;
  readonly bindings: BindingScope;      // id -> output; resolves {{nodes.<id>.output}}
  readonly engine: NodeRunner;          // recursion seam (DIP — executors never import the impl)
  readonly spawn: WorkerSpawnPort;
  readonly progress: ProgressSink;
  readonly clock: Clock;                // existing port — determinism (C5)
  readonly ids: IdGenerator;            // existing port
  readonly log: Logger;
  readonly concurrency: ConcurrencyGate; // in-engine semaphore (§3.9)
  readonly signal: AbortSignal;         // stop/kill propagation (C6)
  // loop metadata (§3.2) injected for loopUntil children:
  readonly iteration?: number;
  readonly lastResult?: unknown;
  readonly lastCount?: number;
  // fan-out metadata injected for forEach/pipeline item children — the body's
  // prompts/refs read these as `{{item}}` / `{{index}}` locals.
  readonly item?: unknown;
  readonly index?: number;
  // subWorkflow resolution seam (§3.10): resolve a stored definition by name,
  // owner already bound by the engine. Absent ⇒ subWorkflow nodes throw.
  readonly resolveDefinition?: (name: string) => WorkflowDefinition | null;
}
