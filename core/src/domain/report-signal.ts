// Report-hold (R7) decision rules — pure. A looped worker's terminal report
// carries a first-line signal (result: / needs input: / failed:). The gate
// decides whether to HOLD it (until the goal-check passes) or PASS it straight
// to the orchestrator. needs-input ALWAYS passes: a human-blocked worker MUST
// reach the orchestrator, and looping it would deadlock.

export type ReportSignal = "result" | "needs-input" | "failed" | "unknown";

// A workflow step-worker's self-declared terminal status (workflow_step_output).
// Distinct from ReportSignal: it is a closed, positive enum (no first-line sniff)
// — `done` is the ONLY success, never the mere absence of a failure token.
export type StepStatus = "done" | "failed" | "needs-input";

// Map a step status to the loop-hold ReportSignal so the SAME decideReportDisposition
// rule governs both the report channel and the step-output channel.
export function signalOfStepStatus(status: StepStatus): ReportSignal {
  return status === "done" ? "result" : status; // failed→failed, needs-input→needs-input
}

// Map a loop-released report's first-line signal back to a step status, so a
// held step-output released through the (text-based) loop machinery resolves the
// node with a faithful status (result/unknown → done; failed/needs-input as-is).
export function stepStatusOfSignal(signal: ReportSignal): StepStatus {
  return signal === "failed" || signal === "needs-input" ? signal : "done";
}

export function classifyReport(text: string): ReportSignal {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (/^\s*needs\s+input\s*:/i.test(first)) return "needs-input";
  if (/^\s*result\s*:/i.test(first)) return "result";
  if (/^\s*failed\s*:/i.test(first)) return "failed";
  return "unknown";
}

export type ReportDisposition = "hold" | "pass";

export function decideReportDisposition(input: {
  signal: ReportSignal;
  loopActive: boolean;
  retryOnFailed?: boolean;
}): ReportDisposition {
  if (!input.loopActive) return "pass";
  switch (input.signal) {
    // A human must decide — never trap it behind the goal gate.
    case "needs-input": return "pass";
    // A completion claim, or an unrecognized first line treated as one: hold for
    // the goal-check.
    case "result":
    case "unknown": return "hold";
    // A self-declared failure passes by default; only held when the loop is
    // configured to keep retrying past a failure.
    case "failed": return input.retryOnFailed ? "hold" : "pass";
  }
}
