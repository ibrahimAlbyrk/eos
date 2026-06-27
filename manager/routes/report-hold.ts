// Report-hold gate (R7), the seam the report route delegates to. A looped
// worker's terminal report is HELD on the loop row (released later by the goal
// tick) unless its disposition is "pass". Returns {held} so the route either
// short-circuits (held) or proceeds to the normal parent dispatch (pass).

import { classifyReport, decideReportDisposition, signalOfStepStatus } from "../../core/src/domain/report-signal.ts";
import type { ReportSignal, StepStatus } from "../../core/src/domain/report-signal.ts";
import type { LoopStateRepo, StepHeldOutput } from "../../core/src/ports/LoopStateRepo.ts";

type HoldLoops = Pick<LoopStateRepo, "findActiveByWorker" | "setHeldReport" | "setAwaitingInput">;
type StepHoldLoops = HoldLoops & Pick<LoopStateRepo, "setHeldOutput">;

export function reportHoldGate(
  loops: HoldLoops,
  workerId: string,
  text: string,
  opts: { retryOnFailed?: boolean } = {},
): { held: boolean } {
  return { held: holdGate(loops, workerId, classifyReport(text), text, opts).held };
}

// The step-output sibling of reportHoldGate: a workflow step-worker's typed output
// holds on the SAME loop machinery (D3). The status maps to a ReportSignal so the
// one decideReportDisposition rule governs both channels; `heldText` is the text
// the goal-check judges, and `heldOutput` is the structured payload the loop
// release re-emits VERBATIM as the node output (typed object + faithful status).
export function stepOutputHoldGate(
  loops: StepHoldLoops,
  workerId: string,
  status: StepStatus,
  heldText: string,
  heldOutput: StepHeldOutput,
  opts: { retryOnFailed?: boolean } = {},
): { held: boolean } {
  const r = holdGate(loops, workerId, signalOfStepStatus(status), heldText, opts);
  // Persist the structured twin alongside the text it just held (cleared together).
  if (r.held && r.loopId) loops.setHeldOutput(r.loopId, heldOutput);
  return { held: r.held };
}

function holdGate(
  loops: HoldLoops,
  workerId: string,
  signal: ReportSignal,
  heldText: string,
  opts: { retryOnFailed?: boolean },
): { held: boolean; loopId?: string } {
  const loop = loops.findActiveByWorker(workerId);
  if (!loop) return { held: false };
  // needs-input passes through to the orchestrator (a human must decide) but
  // pauses the loop: the goal-gate would otherwise re-trigger the worker on its
  // next IDLE, racing the human's answer. Cleared when the answer arrives.
  if (signal === "needs-input") loops.setAwaitingInput(loop.id, true);
  const disposition = decideReportDisposition({
    signal,
    loopActive: true,
    retryOnFailed: opts.retryOnFailed,
  });
  if (disposition === "hold") {
    loops.setHeldReport(loop.id, heldText);
    return { held: true, loopId: loop.id };
  }
  return { held: false };
}
