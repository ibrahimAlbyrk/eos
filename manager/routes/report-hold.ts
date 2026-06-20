// Report-hold gate (R7), the seam the report route delegates to. A looped
// worker's terminal report is HELD on the loop row (released later by the goal
// tick) unless its disposition is "pass". Returns {held} so the route either
// short-circuits (held) or proceeds to the normal parent dispatch (pass).

import { classifyReport, decideReportDisposition } from "../../core/src/domain/report-signal.ts";
import type { LoopStateRepo } from "../../core/src/ports/LoopStateRepo.ts";

export function reportHoldGate(
  loops: Pick<LoopStateRepo, "findActiveByWorker" | "setHeldReport">,
  workerId: string,
  text: string,
  opts: { retryOnFailed?: boolean } = {},
): { held: boolean } {
  const loop = loops.findActiveByWorker(workerId);
  if (!loop) return { held: false };
  const disposition = decideReportDisposition({
    signal: classifyReport(text),
    loopActive: true,
    retryOnFailed: opts.retryOnFailed,
  });
  if (disposition === "hold") {
    loops.setHeldReport(loop.id, text);
    return { held: true };
  }
  return { held: false };
}
