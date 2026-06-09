import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePushPlan,
  summarizePushResult,
  type PushState,
  type PushPlan,
} from "../domain/push-plan.ts";

function state(p: Partial<PushState>): PushState {
  return { branch: "feature", remote: "origin", hasUpstream: true, ahead: 0, behind: 0, ...p };
}

describe("decidePushPlan", () => {
  it("blocks on detached HEAD", () => {
    assert.deepEqual(decidePushPlan(state({ branch: null })), { kind: "blocked", reason: "detached" });
  });

  it("blocks when no remote configured", () => {
    assert.deepEqual(decidePushPlan(state({ remote: null })), { kind: "blocked", reason: "no-remote" });
  });

  it("sets upstream when the branch is local-only", () => {
    assert.deepEqual(
      decidePushPlan(state({ hasUpstream: false, ahead: 3 })),
      { kind: "set-upstream", remote: "origin", branch: "feature" },
    );
  });

  it("fast-forwards when strictly ahead", () => {
    assert.deepEqual(
      decidePushPlan(state({ ahead: 2, behind: 0 })),
      { kind: "fast-forward", remote: "origin", branch: "feature" },
    );
  });

  it("force-with-lease when diverged (rebase/amend)", () => {
    assert.deepEqual(
      decidePushPlan(state({ ahead: 2, behind: 4 })),
      { kind: "force-with-lease", remote: "origin", branch: "feature" },
    );
  });

  it("NEVER forces when strictly behind — pull first", () => {
    assert.deepEqual(decidePushPlan(state({ ahead: 0, behind: 5 })), { kind: "noop", reason: "behind-only" });
  });

  it("noop when up to date", () => {
    assert.deepEqual(decidePushPlan(state({ ahead: 0, behind: 0 })), { kind: "noop", reason: "up-to-date" });
  });
});

describe("summarizePushResult", () => {
  const setUpstream: PushPlan = { kind: "set-upstream", remote: "origin", branch: "f" };
  const ff: PushPlan = { kind: "fast-forward", remote: "origin", branch: "f" };
  const force: PushPlan = { kind: "force-with-lease", remote: "origin", branch: "f" };

  it("maps successful pushes to distinct outcomes", () => {
    assert.equal(summarizePushResult(setUpstream, "pushed").outcome, "pushed-new");
    assert.equal(summarizePushResult(ff, "pushed").outcome, "pushed");
    assert.equal(summarizePushResult(force, "pushed").outcome, "pushed-force");
    assert.equal(summarizePushResult(ff, "pushed").ok, true);
  });

  it("surfaces lease-stale separately from a plain rejection", () => {
    assert.equal(summarizePushResult(force, "lease-stale").outcome, "lease-stale");
    assert.equal(summarizePushResult(force, "lease-stale").ok, false);
    assert.equal(summarizePushResult(ff, "rejected").outcome, "rejected");
  });

  it("maps auth and generic failures", () => {
    assert.equal(summarizePushResult(ff, "auth").outcome, "auth");
    assert.equal(summarizePushResult(ff, "failed").outcome, "failed");
  });

  it("settles noop/blocked plans without an exec reason", () => {
    assert.deepEqual(
      summarizePushResult({ kind: "noop", reason: "up-to-date" }, null),
      { outcome: "up-to-date", ok: true, message: "Already up to date." },
    );
    assert.equal(summarizePushResult({ kind: "noop", reason: "behind-only" }, null).ok, false);
    assert.equal(summarizePushResult({ kind: "blocked", reason: "detached" }, null).outcome, "detached");
    assert.equal(summarizePushResult({ kind: "blocked", reason: "no-remote" }, null).outcome, "no-remote");
  });
});
