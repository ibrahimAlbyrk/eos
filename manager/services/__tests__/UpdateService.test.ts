import { test } from "node:test";
import assert from "node:assert/strict";

import { UpdateService } from "../UpdateService.ts";
import type { UpdateCheck } from "../../../core/src/ports/UpdateSource.ts";

const BEHIND: UpdateCheck = {
  branch: "dev",
  currentSha: "aaaaaaa",
  latestSha: "bbbbbbb",
  behind: 2,
  dirty: false,
  notes: [{ sha: "bbbbbbb", subject: "feat: x" }],
};

function make(initial: UpdateCheck | null, enabled = true) {
  let result = initial;
  const published: Array<{ topic: string; payload: unknown }> = [];
  const applied: Array<{ repoRoot: string; relaunchApp: boolean }> = [];
  const svc = new UpdateService({
    source: { async check() { return result; } },
    applier: { apply(o) { applied.push(o); } },
    bus: {
      publish(topic, payload) { published.push({ topic, payload }); },
      subscribe() { return () => {}; },
    },
    clock: { now: () => 1000 },
    repoRoot: "/repo",
    enabled,
  });
  return { svc, published, applied, setResult: (r: UpdateCheck | null) => { result = r; } };
}

test("check — behind + clean ⇒ available, fires update:available exactly once", async () => {
  const { svc, published } = make(BEHIND);
  const s = await svc.check();
  assert.equal(s.available, true);
  assert.equal(s.behind, 2);
  assert.equal(s.latestSha, "bbbbbbb");
  assert.equal(s.checkedAt, 1000);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "update:available");
  // Same latest on the next poll ⇒ no duplicate banner event.
  await svc.check();
  assert.equal(published.length, 1);
});

test("check — dirty tree is never offered (no nag on a dev checkout)", async () => {
  const { svc, published } = make({ ...BEHIND, dirty: true });
  const s = await svc.check();
  assert.equal(s.available, false);
  assert.equal(s.dirty, true);
  assert.equal(published.length, 0);
});

test("check — up to date ⇒ not available", async () => {
  const { svc } = make({ ...BEHIND, behind: 0, notes: [] });
  const s = await svc.check();
  assert.equal(s.available, false);
});

test("check — source null (offline / no upstream) leaves a benign status", async () => {
  const { svc, published } = make(null);
  const s = await svc.check();
  assert.equal(s.available, false);
  assert.equal(s.checkedAt, 1000);
  assert.equal(published.length, 0);
});

test("apply — refused until an available update is confirmed, then starts the applier", async () => {
  const { svc, applied } = make(BEHIND);
  assert.deepEqual(svc.apply(true), { started: false, reason: "not-available" });
  await svc.check();
  assert.deepEqual(svc.apply(false), { started: true });
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], { repoRoot: "/repo", relaunchApp: false });
});

test("apply — disabled service never applies", async () => {
  const { svc, applied } = make(BEHIND, false);
  await svc.check();
  assert.deepEqual(svc.apply(true), { started: false, reason: "disabled" });
  assert.equal(applied.length, 0);
});

test("defer — hides the banner for the session; cleared once the update no longer applies", async () => {
  const { svc, setResult } = make(BEHIND);
  await svc.check();
  assert.equal(svc.defer().deferred, true);
  assert.equal(svc.getStatus().deferred, true);
  // Re-check while still behind keeps the dismissal…
  await svc.check();
  assert.equal(svc.getStatus().deferred, true);
  // …but once it's applied/gone, the stale dismissal drops.
  setResult({ ...BEHIND, behind: 0, notes: [] });
  await svc.check();
  assert.equal(svc.getStatus().deferred, false);
});
