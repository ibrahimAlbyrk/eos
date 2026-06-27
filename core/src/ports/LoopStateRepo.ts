// LoopStateRepo — persistence port for dynamic-loop rows (worker_loops).
// Adapter is SqliteLoopStateRepo in infra/persistence/. The full surface lands
// now so infra implements it once; later phases call recordAttempt/setHeldReport
// (the re-trigger + report-hold seams).

import type { LoopStatus, LoopStrategy, GoalSpec } from "../../../contracts/src/loop.ts";
import type { StepStatus } from "../domain/report-signal.ts";

// The structured held output of a workflow step-worker node (workflow_step_output),
// stored alongside heldReport so the loop-release republishes the TYPED object +
// its self-declared status VERBATIM — never a stringified body or a status
// re-sniffed from text (which inverts failed→done). Set/cleared with heldReport.
export interface StepHeldOutput {
  output: unknown;
  status: StepStatus;
  reason?: string;
}

export interface LoopRow {
  id: string;
  workerId: string;
  // The owning orchestrator for a worker-loop; null for a self-loop.
  parentId: string | null;
  goal: GoalSpec;
  strategy: LoopStrategy;
  status: LoopStatus;
  attempt: number;
  // Attempt bound; null = unbounded (goal-met is then the only exit).
  maxAttempts: number | null;
  // The worker's report, withheld until the goal check passes (released in P4).
  heldReport: string | null;
  // The structured twin of heldReport for a workflow step-worker node — null for a
  // plain (text-report) loop. Republished verbatim on release (§3.4 / D3 / H2).
  heldOutput: StepHeldOutput | null;
  lastReason: string | null;
  // Paused on a human's answer: the worker reported needs-input, so the goal-gate
  // skips it (no re-trigger, no attempt burned) until the orchestrator replies.
  awaitingInput: boolean;
  // Recent attempt fingerprints — the no-progress/oscillation safety reads this.
  progressRing: LoopAttempt[];
  startedAt: number;
  updatedAt: number;
}

export interface InsertLoopInput {
  id: string;
  workerId: string;
  parentId: string | null;
  goal: GoalSpec;
  strategy: LoopStrategy;
  maxAttempts: number | null;
  startedAt: number;
  updatedAt: number;
}

// One re-trigger attempt's fingerprint: a hash of the worker's change-set, a key
// for its unmet criterion set + that set's size (the no-progress detector reads
// stateHash + unmetCount), plus the reason the goal was deemed unmet.
export interface LoopAttempt {
  stateHash: string;
  outcomeHash: string;
  unmetCount: number;
  reason: string;
}

export interface LoopStateRepo {
  insert(input: InsertLoopInput): void;
  findById(id: string): LoopRow | null;
  findActiveByWorker(workerId: string): LoopRow | null;
  listActive(): LoopRow[];
  setStatus(id: string, status: LoopStatus): void;
  recordAttempt(id: string, attempt: LoopAttempt): void;
  setHeldReport(id: string, text: string | null): void;
  // Store the structured held output (workflow step channel). Cleared together
  // with heldReport — setHeldReport(id, null) also clears it (see the adapter).
  setHeldOutput(id: string, output: StepHeldOutput | null): void;
  setAwaitingInput(id: string, awaiting: boolean): void;
  clear(id: string): void;
}
