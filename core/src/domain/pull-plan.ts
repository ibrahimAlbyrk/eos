// Pure pull decision logic — zero I/O, fully unit-testable. The mirror of
// push-plan.ts: given a branch's sync state, pick the safe git pull variant.
//
// Safety invariant: pull is ONLY ever a fast-forward. A diverged branch
// (ahead>0 && behind>0) is never auto-merged/rebased here — that needs
// conflict resolution, which is the "Sync with remote" git-agent's job. So the
// only actionable plan is fast-forward; everything else resolves without
// touching the working tree.

import type { PullOutcome } from "../../../contracts/src/http.ts";

export interface PullState {
  branch: string | null;   // null = detached HEAD
  hasUpstream: boolean;     // an upstream tracking ref exists for the branch
  ahead: number;            // commits in HEAD not in upstream
  behind: number;           // commits in upstream not in HEAD
}

export type PullPlan =
  | { kind: "fast-forward" }
  | { kind: "noop"; reason: "up-to-date" }
  | { kind: "diverged"; ahead: number; behind: number }
  | { kind: "blocked"; reason: "detached" | "no-upstream" };

// The subset that actually invokes git (the RemoteSync.pull port only ever
// receives this — noop/diverged/blocked are resolved without touching git).
export type ActionablePullPlan = Extract<PullPlan, { kind: "fast-forward" }>;

// Classified outcome of running git pull --ff-only (set by the infra adapter).
export type PullExecReason = "pulled" | "conflict" | "unrelated" | "failed";

export function decidePullPlan(s: PullState): PullPlan {
  if (!s.branch) return { kind: "blocked", reason: "detached" };
  if (!s.hasUpstream) return { kind: "blocked", reason: "no-upstream" };
  if (s.behind === 0) return { kind: "noop", reason: "up-to-date" };
  if (s.ahead === 0) return { kind: "fast-forward" };
  return { kind: "diverged", ahead: s.ahead, behind: s.behind };
}

// The subset that invokes git — the SSOT for "is there a fast-forward to pull".
// Both the pull action and the UI's button-visibility check route through this.
export function isActionablePullPlan(plan: PullPlan): plan is ActionablePullPlan {
  return plan.kind === "fast-forward";
}

export interface PullSummary {
  outcome: PullOutcome;
  ok: boolean;
  message: string;
}

// `reason` is null for plans that never ran git (noop/diverged/blocked).
export function summarizePullResult(plan: PullPlan, reason: PullExecReason | null): PullSummary {
  if (plan.kind === "blocked") {
    return plan.reason === "detached"
      ? { outcome: "detached", ok: false, message: "Detached HEAD — check out a branch to pull." }
      : { outcome: "no-upstream", ok: false, message: "No upstream configured — nothing to pull from." };
  }
  if (plan.kind === "noop") {
    return { outcome: "up-to-date", ok: true, message: "Already up to date." };
  }
  if (plan.kind === "diverged") {
    return {
      outcome: "diverged",
      ok: false,
      message: "Branch diverged — pull can't fast-forward. Use Sync with remote to merge or rebase.",
    };
  }
  switch (reason) {
    case "pulled":
      return { outcome: "pulled", ok: true, message: "Pulled (fast-forward)." };
    case "conflict":
      return { outcome: "conflict", ok: false, message: "Local changes would be overwritten — commit or stash first." };
    case "unrelated":
      return { outcome: "diverged", ok: false, message: "Pull can't fast-forward — remote moved since last fetch." };
    default:
      return { outcome: "failed", ok: false, message: "Pull failed." };
  }
}
