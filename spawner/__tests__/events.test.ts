import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDaemonEventClient } from "../events.ts";

type Sent = { body: { type: string; payload?: unknown; seq: number }; at: number };

function makeFetch(plan: Array<"ok" | "fail">): { sent: Sent[]; fetchFn: typeof fetch; calls(): number } {
  const sent: Sent[] = [];
  let call = 0;
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    const outcome = plan[Math.min(call, plan.length - 1)];
    call += 1;
    if (outcome === "fail") throw new Error("ECONNREFUSED");
    sent.push({ body: JSON.parse(String(init?.body)), at: call });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  return { sent, fetchFn, calls: () => call };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createDaemonEventClient", () => {
  it("no-ops in standalone mode (no daemon url)", async () => {
    const c = createDaemonEventClient(undefined, undefined);
    c.emit("hook", { event: "Stop" });
    await c.drain(10); // resolves immediately
  });

  it("delivers events in emission order with monotonic seq", async () => {
    const f = makeFetch(["ok"]);
    const c = createDaemonEventClient("http://d", "w1", { fetchFn: f.fetchFn });
    c.emit("jsonl", { kind: "assistant_text" });
    c.emit("jsonl", { kind: "tool_use" });
    c.emit("hook", { event: "Stop" });
    await c.drain(500);
    assert.deepEqual(f.sent.map((s) => s.body.type), ["jsonl", "jsonl", "hook"]);
    assert.deepEqual(f.sent.map((s) => s.body.seq), [0, 1, 2]);
  });

  it("retries a failed POST and preserves ordering", async () => {
    const f = makeFetch(["fail", "ok"]); // first attempt fails, retry succeeds
    const c = createDaemonEventClient("http://d", "w1", {
      fetchFn: f.fetchFn, backoffMs: [5, 5, 5], log: () => {},
    });
    c.emit("hook", { event: "Stop" });
    c.emit("heartbeat", {});
    await c.drain(500);
    assert.deepEqual(f.sent.map((s) => s.body.type), ["hook", "heartbeat"]);
    assert.equal(f.calls(), 3); // fail + retry-ok + second event
  });

  it("drops an event after exhausting retries and moves on", async () => {
    const dropped: string[] = [];
    const f = makeFetch(["fail", "fail", "fail", "fail", "ok"]);
    const c = createDaemonEventClient("http://d", "w1", {
      fetchFn: f.fetchFn, backoffMs: [2, 2, 2], log: (m) => dropped.push(m),
    });
    c.emit("jsonl", { kind: "thinking" }); // burns 4 attempts, dropped
    c.emit("hook", { event: "Stop" });     // 5th call succeeds
    await c.drain(500);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.type, "hook");
    assert.ok(dropped.some((m) => m.includes("dropped after retries")));
  });

  it("single in-flight: events emitted mid-flight queue behind, never interleave", async () => {
    let resolveFirst: (() => void) | null = null;
    const order: string[] = [];
    const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
      const b = JSON.parse(String(init?.body)) as { type: string };
      if (b.type === "slow" && resolveFirst === null) {
        await new Promise<void>((r) => { resolveFirst = r; });
      }
      order.push(b.type);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const c = createDaemonEventClient("http://d", "w1", { fetchFn });
    c.emit("slow", {});
    await sleep(5);
    c.emit("after", {});
    await sleep(5);
    assert.deepEqual(order, []); // first still in flight, second queued
    resolveFirst!();
    await c.drain(500);
    assert.deepEqual(order, ["slow", "after"]);
  });

  it("drain resolves once the queue empties", async () => {
    const f = makeFetch(["ok"]);
    const c = createDaemonEventClient("http://d", "w1", { fetchFn: f.fetchFn });
    c.emit("lifecycle", { phase: "pty_exit" });
    await c.drain(1000);
    assert.equal(f.sent.length, 1);
  });
});
