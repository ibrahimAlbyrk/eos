import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePullPlan,
  isActionablePullPlan,
  summarizePullResult,
  type PullState,
  type PullPlan,
} from "../domain/pull-plan.ts";

function state(p: Partial<PullState>): PullState {
  return { branch: "feature", hasUpstream: true, ahead: 0, behind: 0, ...p };
}

describe("decidePullPlan", () => {
  it("blocks on detached HEAD", () => {
    assert.deepEqual(decidePullPlan(state({ branch: null })), { kind: "blocked", reason: "detached" });
  });

  it("blocks when there is no upstream", () => {
    assert.deepEqual(decidePullPlan(state({ hasUpstream: false, behind: 3 })), { kind: "blocked", reason: "no-upstream" });
  });

  it("fast-forwards when strictly behind", () => {
    assert.deepEqual(decidePullPlan(state({ ahead: 0, behind: 4 })), { kind: "fast-forward" });
  });

  it("reports diverged when both ahead and behind (no auto-merge)", () => {
    assert.deepEqual(decidePullPlan(state({ ahead: 2, behind: 4 })), { kind: "diverged", ahead: 2, behind: 4 });
  });

  it("noop when up to date", () => {
    assert.deepEqual(decidePullPlan(state({ ahead: 0, behind: 0 })), { kind: "noop", reason: "up-to-date" });
  });

  it("noop when only ahead — nothing to pull", () => {
    assert.deepEqual(decidePullPlan(state({ ahead: 3, behind: 0 })), { kind: "noop", reason: "up-to-date" });
  });
});

describe("isActionablePullPlan", () => {
  it("treats only fast-forward as actionable", () => {
    assert.equal(isActionablePullPlan(decidePullPlan(state({ behind: 1 }))), true);
  });

  it("treats noop/diverged/blocked as NOT actionable", () => {
    assert.equal(isActionablePullPlan(decidePullPlan(state({}))), false);
    assert.equal(isActionablePullPlan(decidePullPlan(state({ ahead: 1, behind: 1 }))), false);
    assert.equal(isActionablePullPlan(decidePullPlan(state({ branch: null }))), false);
    assert.equal(isActionablePullPlan(decidePullPlan(state({ hasUpstream: false }))), false);
  });
});

describe("summarizePullResult", () => {
  const ff: PullPlan = { kind: "fast-forward" };

  it("maps a successful fast-forward", () => {
    assert.equal(summarizePullResult(ff, "pulled").outcome, "pulled");
    assert.equal(summarizePullResult(ff, "pulled").ok, true);
  });

  it("surfaces local-change conflict separately from a non-ff failure", () => {
    assert.equal(summarizePullResult(ff, "conflict").outcome, "conflict");
    assert.equal(summarizePullResult(ff, "conflict").ok, false);
    assert.equal(summarizePullResult(ff, "unrelated").outcome, "diverged");
    assert.equal(summarizePullResult(ff, "failed").outcome, "failed");
  });

  it("settles diverged/noop/blocked plans without an exec reason", () => {
    assert.equal(summarizePullResult({ kind: "diverged", ahead: 1, behind: 1 }, null).outcome, "diverged");
    assert.equal(summarizePullResult({ kind: "diverged", ahead: 1, behind: 1 }, null).ok, false);
    assert.deepEqual(
      summarizePullResult({ kind: "noop", reason: "up-to-date" }, null),
      { outcome: "up-to-date", ok: true, message: "Already up to date." },
    );
    assert.equal(summarizePullResult({ kind: "blocked", reason: "detached" }, null).outcome, "detached");
    assert.equal(summarizePullResult({ kind: "blocked", reason: "no-upstream" }, null).outcome, "no-upstream");
  });
});
