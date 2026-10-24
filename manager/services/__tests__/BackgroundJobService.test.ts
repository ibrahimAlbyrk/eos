import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobService, sliceOutput, type BackgroundJobServiceDeps } from "../BackgroundJobService.ts";
import type { BackgroundJob, BackgroundJobChange } from "../../../contracts/src/background-job.ts";
import type { TransferRecord } from "../../../contracts/src/transfer.ts";
import type { DreamStatus } from "../../../contracts/src/dream.ts";

function harness(over: Partial<BackgroundJobServiceDeps> = {}) {
  const changes: BackgroundJobChange[] = [];
  let t = 1000;
  const calls: string[] = [];
  const session = { isAlive: () => true, stopTask: async (id: string) => { calls.push(`stopTask:${id}`); return { ok: true }; } };
  const svc = new BackgroundJobService({
    bus: { publish: (_topic, payload) => { changes.push(payload as BackgroundJobChange); } },
    session: () => session,
    cancelTransfer: (id) => { calls.push(`cancel:${id}`); },
    stopDream: () => { calls.push("stopDream"); return true; },
    killTerminal: (runId) => { calls.push(`kill:${runId}`); return true; },
    machineName: (ref) => (ref === "local" ? "This Mac" : "MacBook Air"),
    now: () => t,
    throttleMs: 0,
    ...over,
  });
  const jobs = (): BackgroundJob[] => svc.list();
  const job = (id: string): BackgroundJob | undefined => jobs().find((j) => j.id === id);
  return { svc, changes, calls, jobs, job, tick: (ms: number) => { t += ms; } };
}

const startShell = (h: ReturnType<typeof harness>, taskId = "b1") =>
  h.svc.onBackgroundTask("w1", { phase: "started", taskId, callId: "toolu_1", kind: "shell", title: "Start dev server", command: "npm run dev", outputFile: null });

describe("BackgroundJobService", () => {
  it("tracks a background shell from start to a non-zero exit, which reads as failed", () => {
    const h = harness();
    startShell(h);
    assert.deepEqual(h.job("shell:w1:b1"), {
      id: "shell:w1:b1", kind: "shell", status: "running", workerId: "w1", title: "Start dev server", command: "npm run dev",
      detail: null, startedAt: 1000, endedAt: null, progress: null, exitCode: null, callId: "toolu_1", hasOutput: false, canStop: true,
    });
    h.tick(5000);
    h.svc.onBackgroundTask("w1", { phase: "ended", taskId: "b1", status: "completed", summary: "Background command completed (exit code 1)", outputFile: null, exitCode: 1 });
    const j = h.job("shell:w1:b1")!;
    assert.equal(j.status, "failed");
    assert.equal(j.exitCode, 1);
    assert.equal(j.endedAt, 6000);
    assert.equal(j.canStop, false);
  });

  it("reads a shell's output file from an offset", () => {
    const h = harness();
    const file = join(mkdtempSync(join(tmpdir(), "jobs-")), "b1.output");
    writeFileSync(file, "line one\n");
    startShell(h);
    h.svc.onBackgroundTask("w1", { phase: "output", taskId: "b1", outputFile: file });
    assert.equal(h.job("shell:w1:b1")?.hasOutput, true);
    const first = h.svc.output("shell:w1:b1", 0)!;
    assert.deepEqual(first, { text: "line one\n", next: 9, truncated: false, reset: false });
    appendFileSync(file, "line two\n");
    assert.equal(h.svc.output("shell:w1:b1", first.next)?.text, "line two\n");
    assert.equal(h.svc.output("shell:w1:b1", 999)?.reset, true);
  });

  it("counts a Monitor's events and keeps them as its output", () => {
    const h = harness();
    h.svc.onBackgroundTask("w1", { phase: "started", taskId: "m1", callId: "toolu_m", kind: "monitor", title: "test watcher", command: "tail -f t.log", outputFile: null });
    h.svc.onBackgroundTask("w1", { phase: "event", taskId: "m1", text: "PASS a.spec" });
    h.svc.onBackgroundTask("w1", { phase: "event", taskId: "m1", text: "FAIL b.spec" });
    assert.equal(h.job("monitor:w1:m1")?.detail, "2 events · FAIL b.spec");
    assert.equal(h.svc.output("monitor:w1:m1", 0)?.text, "PASS a.spec\nFAIL b.spec\n");
  });

  it("follows a background subagent, its progress and its end; a resume runs the same job again", () => {
    const h = harness();
    h.svc.observe("w1", { type: "subagent_started", callId: "toolu_a", agentId: "ag1", background: true, agentType: "Explore", description: "map sources" });
    h.svc.onBackgroundTask("w1", { phase: "progress", taskId: "ag1", lastTool: "Read", toolUses: 14 });
    assert.equal(h.job("agent:w1:ag1")?.title, "Explore · map sources");
    assert.equal(h.job("agent:w1:ag1")?.detail, "Read · 14 tool uses");
    h.svc.observe("w1", { type: "subagent_completed", agentId: "ag1", callId: "toolu_a", status: "completed", result: "Found 6 sources.\nDetails…" });
    assert.equal(h.job("agent:w1:ag1")?.status, "completed");
    assert.equal(h.job("agent:w1:ag1")?.detail, "Found 6 sources.");
    h.svc.observe("w1", { type: "subagent_started", callId: "toolu_s", agentId: "ag1", background: true, resumes: "toolu_a" });
    assert.equal(h.job("agent:w1:ag1")?.status, "running");
    assert.equal(h.job("agent:w1:ag1")?.callId, "toolu_a");
  });

  it("stops a session task through the session, and refuses when the session can't", async () => {
    const h = harness();
    h.svc.observe("w1", { type: "workflow_started", callId: "toolu_w", taskId: "wt1", name: "review-changes" });
    assert.deepEqual(await h.svc.stop("workflow:w1:toolu_w"), { ok: true });
    assert.deepEqual(h.calls, ["stopTask:wt1"]);
    const none = harness({ session: () => null });
    startShell(none);
    assert.equal(none.job("shell:w1:b1")?.canStop, false);
    assert.deepEqual(await none.svc.stop("shell:w1:b1"), { ok: false, status: 409, error: "this session can't stop that job" });
  });

  it("shows Workflow progress as the current phase and agents done", () => {
    const h = harness();
    h.svc.observe("w1", { type: "workflow_started", callId: "toolu_w", taskId: "wt1", name: "review-changes" });
    h.svc.onWorkflowProgress({
      workerId: "w1", callId: "toolu_w", taskId: "wt1", status: "running", updatedAt: 1,
      snapshot: {
        phases: [{ index: 1, title: "Review" }, { index: 2, title: "Verify" }],
        agents: [{ index: 1, label: "a", phaseIndex: 1, state: "done" }, { index: 2, label: "b", phaseIndex: 2, state: "running" }],
        logs: [],
      },
    });
    const j = h.job("workflow:w1:toolu_w")!;
    assert.equal(j.detail, "Verify 2/2 · 2 agents");
    assert.deepEqual(j.progress, { done: 1, total: 2 });
  });

  it("runs a `!` command: output from its chunks, kill on stop, stopped by the user", async () => {
    const h = harness();
    h.svc.onTerminalStart({ workerId: "w1", runId: "r1", command: "make", startedAt: 900 });
    h.svc.onTerminalChunk({ runId: "r1", data: "cc a.c\ncc b.c\n" });
    assert.equal(h.job("shell:w1:run-r1")?.detail, "cc b.c");
    assert.equal(h.svc.output("shell:w1:run-r1", 0)?.text, "cc a.c\ncc b.c\n");
    await h.svc.stop("shell:w1:run-r1");
    assert.deepEqual(h.calls, ["kill:r1"]);
    h.svc.onTerminalDone({ runId: "r1", exitCode: 143, note: "stopped by user" });
    assert.equal(h.job("shell:w1:run-r1")?.status, "stopped");
  });

  it("mirrors a transfer, and ignores one that ended before it was seen", () => {
    const h = harness();
    const t = (status: TransferRecord["status"], done: number): TransferRecord => ({
      id: "t1", from: "local", to: "a".repeat(64), origin: { kind: "user" }, sources: ["/x/Eos-0.42.dmg"], destDir: "/d", destReason: "default",
      status, error: null, roots: [], fileCount: 1, totalBytes: 2048, doneBytes: done, rate: 0, route: "direct", conflicts: [], decisions: {}, placed: [],
      createdAt: 500, startedAt: 600, finishedAt: null,
    });
    h.svc.onTransfer({ transfer: { ...t("done", 2048), id: "old" } });
    assert.equal(h.jobs().length, 0);
    h.svc.onTransfer({ transfer: t("copying", 1024) });
    const j = h.job("transfer:eos:t1")!;
    assert.equal(j.title, "Eos-0.42.dmg → MacBook Air");
    assert.deepEqual(j.progress, { done: 1024, total: 2048 });
    assert.equal(j.startedAt, 600);
    h.svc.onTransfer({ transfer: t("done", 2048) });
    assert.equal(h.job("transfer:eos:t1")?.status, "completed");
    h.svc.onTransfer({ removed: ["t1"] });
    assert.equal(h.jobs().length, 0);
  });

  it("follows a dream; a skipped one leaves nothing behind", () => {
    const h = harness();
    const status = (running: boolean, done = 0): DreamStatus => ({
      running, runId: null, progress: running ? { done, total: 12, chat: null, noticed: [] } : null, lastRun: null, nextAt: null, blocked: null,
    });
    h.svc.onDream({ runId: null, status: "running" }, status(true, 7));
    const id = h.jobs()[0].id;
    assert.equal(h.job(id)?.title, "Dreaming over 12 chats");
    assert.equal(h.job(id)?.detail, "Read 7 of 12");
    h.svc.onDream({ runId: "dr-1", status: "done" }, status(false));
    assert.equal(h.job(id)?.status, "completed");
    h.svc.onDream({ runId: null, status: "running" }, status(true));
    h.svc.onDream({ runId: null, status: "skipped" }, status(false));
    assert.equal(h.jobs().length, 1);
  });

  it("shows compaction only while it runs, and a sync pass only once it outlasts syncShowMs", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness({ syncShowMs: 1500 });
    h.svc.onCompaction("w1", true);
    assert.equal(h.job("compaction:w1:context")?.status, "running");
    h.svc.onCompaction("w1", false);
    assert.equal(h.jobs().length, 0);
    const sync = { phase: "syncing", relay: null, lastSyncAt: null, error: null, counts: {} } as never;
    h.svc.onSync(sync);
    h.svc.onSync({ phase: "idle", relay: null, lastSyncAt: 1, error: null, counts: {} } as never);
    t.mock.timers.tick(2000);
    assert.equal(h.jobs().length, 0, "a quick pass never shows");
    h.svc.onSync(sync);
    t.mock.timers.tick(1500);
    assert.equal(h.job("sync:eos:sync")?.status, "running");
  });

  it("coalesces updates inside the throttle window but sends a start and an end at once", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness({ throttleMs: 500 });
    h.svc.onBackgroundTask("w1", { phase: "started", taskId: "m1", callId: "c", kind: "monitor", title: "m", command: null, outputFile: null });
    h.svc.onBackgroundTask("w1", { phase: "event", taskId: "m1", text: "a" });
    h.svc.onBackgroundTask("w1", { phase: "event", taskId: "m1", text: "b" });
    assert.equal(h.changes.length, 1);
    h.tick(500);
    t.mock.timers.tick(500);
    assert.equal(h.changes.length, 2);
    assert.equal(h.changes[1].job?.detail, "2 events · b");
    h.svc.onBackgroundTask("w1", { phase: "ended", taskId: "m1", status: "completed", summary: null, outputFile: null, exitCode: null });
    assert.equal(h.changes.length, 3);
  });

  it("keeps the newest finished jobs, and drops them on dismiss, clear or a removed worker", () => {
    const h = harness({ finishedMax: 2 });
    for (const id of ["a", "b", "c"]) {
      startShell(h, id);
      h.tick(10);
      h.svc.onBackgroundTask("w1", { phase: "ended", taskId: id, status: "completed", summary: null, outputFile: null, exitCode: 0 });
    }
    assert.deepEqual(h.jobs().map((j) => j.id), ["shell:w1:c", "shell:w1:b"]);
    assert.deepEqual(h.svc.dismiss("shell:w1:c"), { ok: true });
    startShell(h, "d");
    h.svc.clearFinished();
    assert.deepEqual(h.jobs().map((j) => j.id), ["shell:w1:d"]);
    h.svc.forgetWorker("w1");
    assert.deepEqual(h.jobs(), []);
  });
});

describe("sliceOutput", () => {
  it("returns what follows the offset, resets past the end, keeps only the newest when there is too much", () => {
    assert.deepEqual(sliceOutput("abcdef", 10, 12), { text: "cdef", next: 16, truncated: false, reset: false });
    assert.deepEqual(sliceOutput("abcdef", 10, 99), { text: "abcdef", next: 16, truncated: false, reset: true });
    assert.deepEqual(sliceOutput("abcdef", 10, 0), { text: "abcdef", next: 16, truncated: true, reset: false });
    const big = "x".repeat(70 * 1024);
    const out = sliceOutput(big, 0, 0);
    assert.equal(out.text.length, 64 * 1024);
    assert.equal(out.truncated, true);
  });
});
