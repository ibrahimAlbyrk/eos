// Pure push decision logic — zero I/O, fully unit-testable. Given a branch's
// sync state, pick the correct git push variant; given the executed plan and
// the adapter's classified outcome, summarize a user-facing result.
//
// Safety invariant: force is chosen ONLY when the local branch both leads and
// trails its upstream (ahead>0 && behind>0 — the rebase/amend shape). A branch
// that is strictly behind (ahead==0 && behind>0) is NEVER force-pushed; that
// would discard remote commits. force-with-lease additionally refuses to
// overwrite a remote that moved since our last fetch.

import type { PushOutcome } from "../../../contracts/src/http.ts";

export interface PushState {
  branch: string | null;   // null = detached HEAD
  remote: string | null;   // null = no remote configured
  hasUpstream: boolean;    // an upstream tracking ref exists for the branch
  ahead: number;           // commits in HEAD not in upstream
  behind: number;          // commits in upstream not in HEAD
}

export type PushPlan =
  | { kind: "set-upstream"; remote: string; branch: string }
  | { kind: "fast-forward"; remote: string; branch: string }
  | { kind: "force-with-lease"; remote: string; branch: string }
  | { kind: "noop"; reason: "up-to-date" | "behind-only" }
  | { kind: "blocked"; reason: "detached" | "no-remote" };

// The subset of plans that actually invoke git (the BranchPush port only ever
// receives one of these — noop/blocked are resolved without touching git).
export type ActionablePushPlan = Extract<
  PushPlan,
  { kind: "set-upstream" | "fast-forward" | "force-with-lease" }
>;

// Classified outcome of running git push (set by the infra adapter).
export type PushExecReason = "pushed" | "rejected" | "lease-stale" | "auth" | "failed";

export function decidePushPlan(s: PushState): PushPlan {
  if (!s.branch) return { kind: "blocked", reason: "detached" };
  if (!s.remote) return { kind: "blocked", reason: "no-remote" };
  if (!s.hasUpstream) return { kind: "set-upstream", remote: s.remote, branch: s.branch };
  if (s.ahead > 0 && s.behind === 0) return { kind: "fast-forward", remote: s.remote, branch: s.branch };
  if (s.ahead > 0 && s.behind > 0) return { kind: "force-with-lease", remote: s.remote, branch: s.branch };
  if (s.behind > 0) return { kind: "noop", reason: "behind-only" };
  return { kind: "noop", reason: "up-to-date" };
}

// The subset that invokes git — the SSOT for "is there something to push".
// Both the push action and the UI's button-visibility check route through this.
export function isActionablePushPlan(plan: PushPlan): plan is ActionablePushPlan {
  return (
    plan.kind === "set-upstream" ||
    plan.kind === "fast-forward" ||
    plan.kind === "force-with-lease"
  );
}

export interface PushSummary {
  outcome: PushOutcome;
  ok: boolean;
  message: string;
}

// `reason` is null for plans that never ran git (noop/blocked).
export function summarizePushResult(plan: PushPlan, reason: PushExecReason | null): PushSummary {
  if (plan.kind === "blocked") {
    return plan.reason === "detached"
      ? { outcome: "detached", ok: false, message: "Detached HEAD — check out a branch to push." }
      : { outcome: "no-remote", ok: false, message: "No remote configured." };
  }
  if (plan.kind === "noop") {
    return plan.reason === "up-to-date"
      ? { outcome: "up-to-date", ok: true, message: "Already up to date." }
      : { outcome: "behind-only", ok: false, message: "Nothing to push — branch is behind. Pull first." };
  }
  switch (reason) {
    case "pushed":
      if (plan.kind === "set-upstream") return { outcome: "pushed-new", ok: true, message: "Pushed and set upstream." };
      if (plan.kind === "force-with-lease") return { outcome: "pushed-force", ok: true, message: "Force-pushed (with lease)." };
      return { outcome: "pushed", ok: true, message: "Pushed." };
    case "rejected":
      return { outcome: "rejected", ok: false, message: "Push rejected — remote moved. Pull/rebase first." };
    case "lease-stale":
      return { outcome: "lease-stale", ok: false, message: "Force-push rejected — remote moved since last fetch." };
    case "auth":
      return { outcome: "auth", ok: false, message: "Authentication failed." };
    default:
      return { outcome: "failed", ok: false, message: "Push failed." };
  }
}
