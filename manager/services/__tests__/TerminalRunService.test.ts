import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import type { EventBus, EventBusMessage, EventBusTopic } from "../../../core/src/ports/EventBus.ts";
import { TerminalRunService } from "../TerminalRunService.ts";

interface Appended {
  workerId: string;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

function harness() {
  const appended: Appended[] = [];
  const published: { topic: EventBusTopic; payload: unknown }[] = [];
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((res) => { resolveDone = res; });
  const bus: EventBus = {
    publish(topic: EventBusTopic, payload: unknown): void {
      published.push({ topic, payload });
      if (topic === "terminal:done") resolveDone?.();
    },
    subscribe(_topic: EventBusTopic | "*", _fn: (msg: EventBusMessage) => void): () => void {
      return () => {};
    },
  };
  const svc = new TerminalRunService({
    bus,
    events: {
      append(workerId: string, ts: number, type: string, payload: unknown): number {
        appended.push({ workerId, ts, type, payload: payload as Record<string, unknown> });
        return appended.length;
      },
    },
    clock: { now: () => Date.now() },
    log: { warn() {} },
  });
  return { svc, appended, published, done };
}

describe("TerminalRunService", () => {
  it("runs a command, streams a chunk, persists one terminal event", async () => {
    const { svc, appended, published, done } = harness();
    const { runId } = svc.run("w1", tmpdir(), "echo hi");
    await done;

    const chunks = published.filter((p) => p.topic === "terminal:chunk");
    assert.ok(chunks.length >= 1);
    const chunk = chunks[0].payload as { workerId: string; runId: string; command: string; data: string };
    assert.equal(chunk.workerId, "w1");
    assert.equal(chunk.runId, runId);
    assert.equal(chunk.command, "echo hi");
    assert.ok(chunk.data.includes("hi"));

    assert.equal(appended.length, 1);
    const ev = appended[0];
    assert.equal(ev.workerId, "w1");
    assert.equal(ev.type, "terminal");
    assert.equal(ev.payload.runId, runId);
    assert.equal(ev.payload.exitCode, 0);
    assert.ok(String(ev.payload.output).includes("hi"));
    assert.equal(ev.payload.truncated, false);

    assert.ok(published.some((p) => p.topic === "worker:change"));
  });

  it("reports the command's exit code", async () => {
    const { svc, appended, done } = harness();
    svc.run("w1", tmpdir(), "exit 3");
    await done;
    assert.equal(appended[0].payload.exitCode, 3);
  });

  it("captures stderr alongside stdout", async () => {
    const { svc, appended, done } = harness();
    svc.run("w1", tmpdir(), "echo err >&2");
    await done;
    assert.ok(String(appended[0].payload.output).includes("err"));
  });

  it("workspace run (null workerId) streams but persists nothing", async () => {
    const { svc, appended, published, done } = harness();
    svc.run(null, tmpdir(), "echo ws");
    await done;
    assert.equal(appended.length, 0);
    assert.ok(published.some((p) => p.topic === "terminal:chunk"));
    assert.ok(published.some((p) => p.topic === "terminal:done"));
    assert.ok(!published.some((p) => p.topic === "worker:change"));
  });

  it("kill stops a running command and notes it", async () => {
    const { svc, appended, done } = harness();
    const { runId } = svc.run("w1", tmpdir(), "sleep 30");
    assert.equal(svc.kill(runId), true);
    await done;
    assert.equal(appended[0].payload.note, "stopped by user");
    assert.equal(svc.kill(runId), false);
  });
});
