// Pure no-progress / oscillation detector — the only safety net on an unbounded
// loop (budget was removed). Reads the bounded progress ring (the last
// noProgressWindow attempts) and flags FROZEN (an identical change-set across the
// whole window) or OSCILLATION (cycling between a few change-sets) while the
// worker is NOT converging (the unmet count isn't shrinking).
//
// Limitation (by design — bounded ring): a worker that emits a genuinely NEW
// change-set every attempt while never closing a criterion ("thrasher") is not
// flagged here — that needs a persistent stagnation counter beyond the window
// (a possible follow-up). The attempt limit + frozen/oscillation cover the rest.

export interface ProgressEntry {
  stateHash: string;
  unmetCount: number;
}

// Cycling between at most this many distinct change-sets (while not converging)
// reads as oscillation; 1 distinct is reported as frozen instead.
const OSCILLATION_DISTINCT_MAX = 2;

export type NoProgressReason = "frozen" | "oscillation";

// A stable key for an unmet criterion set — the directive's outcomeHash. Equal
// key ⇒ same unmet set. No crypto needed (core is pure); a sorted join is a
// sufficient equality key.
export function outcomeKey(unmet: string[]): string {
  return [...unmet].sort().join("|");
}

// Returns why the loop is making no progress over the full window, or null when
// it still has room to run.
export function detectNoProgress(ring: ProgressEntry[], window: number): NoProgressReason | null {
  if (window < 1 || ring.length < window) return null; // need a full window first
  const w = ring.slice(-window);
  // Convergence: the unmet count strictly fell across the window ⇒ the worker is
  // closing criteria ⇒ never flag.
  if (w[w.length - 1].unmetCount < w[0].unmetCount) return null;
  const distinct = new Set(w.map((e) => e.stateHash)).size;
  if (distinct === 1) return "frozen";
  if (distinct <= OSCILLATION_DISTINCT_MAX) return "oscillation";
  return null;
}
