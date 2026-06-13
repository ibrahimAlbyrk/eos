import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BackgroundActivityService,
  classifyBackgroundTool,
  parseShellId,
} from "../BackgroundActivityService.ts";

const clock = { now: () => 1000 };

test("classifyBackgroundTool — Monitor prefers description, then command, then fallback", () => {
  assert.deepEqual(classifyBackgroundTool("Monitor", { description: "watch logs" }), { kind: "monitor", label: "watch logs" });
  assert.deepEqual(classifyBackgroundTool("Monitor", { command: "tail -f x" }), { kind: "monitor", label: "tail -f x" });
  assert.deepEqual(classifyBackgroundTool("Monitor", {}), { kind: "monitor", label: "monitor" });
});

test("classifyBackgroundTool — Bash counts only with run_in_background, other tools never", () => {
  assert.deepEqual(classifyBackgroundTool("Bash", { command: "sleep 9", run_in_background: true }), { kind: "bash", label: "sleep 9" });
  assert.equal(classifyBackgroundTool("Bash", { command: "ls" }), null);
  assert.equal(classifyBackgroundTool("Read", { run_in_background: true }), null);
});

test("parseShellId — pulls the id from the background reply and strips trailing punctuation", () => {
  assert.equal(parseShellId("Command running in background with ID: bshuk700g. Output is..."), "bshuk700g");
  assert.equal(parseShellId("no id here"), null);
});

test("service — tracks a start, records the shell id on done, ignores non-background tools", () => {
  const svc = new BackgroundActivityService(clock);
  svc.onToolRunning("w1", "Monitor", "t1", { description: "deploy" });
  svc.onToolRunning("w1", "Read", "t2", {});
  const list = svc.forWorker("w1");
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0] }, { kind: "monitor", toolUseId: "t1", label: "deploy", startedAt: 1000, shellId: null });
  svc.onToolDone("w1", "Monitor", "t1", "running in background with ID: mon42.");
  assert.equal(svc.forWorker("w1")[0].shellId, "mon42");
});

test("service — de-dups a re-emitted start and clears everything on worker teardown", () => {
  const svc = new BackgroundActivityService(clock);
  svc.onToolRunning("w1", "Bash", "t1", { command: "x", run_in_background: true });
  svc.onToolRunning("w1", "Bash", "t1", { command: "x", run_in_background: true });
  assert.equal(svc.forWorker("w1").length, 1);
  svc.clearWorker("w1");
  assert.deepEqual(svc.forWorker("w1"), []);
});
