// EvidenceCollector — gathers the ARTIFACTS the judge grades (machine signals,
// git diff, file contents), never the worker's self-claims. The adapter
// (infra/goalcheck) runs verify commands + reads the worker's diff. Every
// artifact is truncated by the adapter so the bundle stays prompt-sized.

import type { GoalSpec } from "../../../contracts/src/loop.ts";
import type { GoalContext } from "./GoalCheckStrategy.ts";

// One verify/evidence command's machine result — the strongest artifact: a
// command, its exit code, and its (truncated) combined output.
export interface MachineSignal {
  criterionId?: string;
  command: string;
  exitCode: number;
  output: string;
}

export interface EvidenceFile {
  path: string;
  content: string;
}

export interface EvidenceBundle {
  machineSignals: MachineSignal[];
  diff?: string;
  files?: EvidenceFile[];
  // The worker's own report — a CLAIM to verify, NEVER accepted on its word.
  reportClaim?: string;
}

export interface EvidenceCollector {
  collect(goal: GoalSpec, ctx: GoalContext): Promise<EvidenceBundle>;
}
