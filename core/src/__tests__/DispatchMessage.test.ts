import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { AgentBackend, AgentSession } from "../ports/AgentBackend.ts";
import type { MessageRecord } from "../ports/WorkerClient.ts";

import { fakeQueue, type QueueRow } from "./helpers/fakeMessageQueue.ts";

interface AppendedEvent { type: string; payload: unknown }

function buildDeps(opts: {
  backend?: AgentBackend;
  backendKind?: string | null;
  state?: string;
  sendResult?: { ok: boolean; status: number; body: unknown };
} = {}): {
  deps: DispatchMessageDeps;
  events: AppendedEvent[];
  clientSends: Array<{ text: string; record?: MessageRecord }>;
  queueRows: QueueRow[];
  published: Array<{ topic: string; payload: unknown }>;
} {
  const events: AppendedEvent[] = [];
  const clientSends: Array<{ text: string; record?: MessageRecord }> = [];
  const published: Array<{ topic: string; payload: unknown }> = [];
  const queue = fakeQueue();
  const row = {
    id: "w1", state: opts.state ?? "IDLE", port: 7501, pid: 42,
    backend_kind: opts.backendKind ?? null, is_orchestrator: 0,
  };

  const deps = {
    workers: {
      findById: () => row as unknown as WorkerRow,
      updateState: () => {},
      setTurnStartedAt: () => {},
    },
    events: {
      append: (_id: string, _ts: number, type: string, payload: unknown) => {
        events.push({ type, payload });
        return events.length;
      },
    },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    clock: { now: () => 1234 },
    queue: queue.repo,
    client: {
      sendMessage: async (_port: number, text: string, record?: MessageRecord) => {
        clientSends.push({ text, record });
        return opts.sendResult ?? { ok: true, status: 200, body: { ok: true } };
      },
    },
    ...(opts.backend
      ? { backends: { has: (k: string) => k === opts.backend!.kind, get: () => opts.backend! } }
      : {}),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
  } as unknown as DispatchMessageDeps;

  return { deps, events, clientSends, queueRows: queue.rows, published };
}

function fakeBackend(kind: string, reportsMessageEvents: boolean, sends: Array<{ text: string; record?: MessageRecord }>): AgentBackend {
  const session = {
    workerId: "w1",
    handle: { kind: "http", port: 7501, pid: 42 },
    capabilities: { interrupt: true, keystroke: true, runtimeModelSwitch: true, runtimePermissionSwitch: true, reportsMessageEvents },
    sendMessage: async (text: string, record?: MessageRecord) => {
      sends.push({ text, record });
      return { ok: true, status: 200, body: { ok: true } };
    },
  } as unknown as AgentSession;
  return { kind, start: async () => session, attach: () => session };
}

const userMessages = (events: AppendedEvent[]) => events.filter((e) => e.type === "user_message");

describe("dispatchMessage — transcript-anchored message events", () => {
  it("self-reporting backend: no dispatch-time append, record rides to the worker", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "hello" });
    assert.deepEqual(userMessages(events), []);
    assert.deepEqual(sends, [{ text: "hello", record: { as: "user_message", sentAt: 1234 } }]);
  });

  it("self-reporting backend: displayText rides in the record, full text to the PTY", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "full action prompt", displayText: "/commit" });
    assert.deepEqual(userMessages(events), []);
    assert.deepEqual(sends, [{ text: "full action prompt", record: { as: "user_message", sentAt: 1234, displayText: "/commit" } }]);
  });

  it("non-reporting backend keeps the dispatch-time append and gets no record", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, { workerId: "w1", text: "hello" });
    assert.deepEqual(userMessages(events), [{ type: "user_message", payload: { text: "hello" } }]);
    assert.deepEqual(sends, [{ text: "hello", record: undefined }]);
  });

  it("legacy port path (no backends) behaves as claude-cli: record sent, no append", async () => {
    const { deps, events, clientSends } = buildDeps();
    await dispatchMessage(deps, { workerId: "w1", text: "hello" });
    assert.deepEqual(userMessages(events), []);
    assert.deepEqual(clientSends, [{ text: "hello", record: { as: "user_message", sentAt: 1234 } }]);
  });

  it("still lifts the worker to WORKING eagerly", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "hello" });
    const states = events.filter((e) => e.type === "state").map((e) => e.payload as { state?: string });
    assert.equal(states.length, 1);
    assert.equal(states[0].state, "WORKING");
  });
});

describe("dispatchMessage — daemon-side queue + idempotency", () => {
  it("queueWhenBusy + WORKING: 202 queued, nothing sent, pending row + bus signal", async () => {
    const { deps, clientSends, queueRows, published } = buildDeps({ state: "WORKING" });
    const r = await dispatchMessage(deps, { workerId: "w1", text: "later", clientMsgId: "c1", queueWhenBusy: true });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { ok: true, queued: true, queueId: 1 });
    assert.equal(clientSends.length, 0);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].dispatchedAt, null);
    assert.ok(published.some((p) => p.topic === "worker:change"));
  });

  it("queueWhenBusy + IDLE: dispatches directly, claim row recorded as dispatched", async () => {
    const { deps, clientSends, queueRows } = buildDeps();
    const r = await dispatchMessage(deps, { workerId: "w1", text: "now", clientMsgId: "c1", queueWhenBusy: true });
    assert.equal(r.status, 200);
    assert.equal(clientSends.length, 1);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].dispatchedAt, 1234);
  });

  it("duplicate clientMsgId is a no-op: one send, second returns deduped", async () => {
    const { deps, clientSends } = buildDeps();
    await dispatchMessage(deps, { workerId: "w1", text: "hello", clientMsgId: "c1" });
    const r2 = await dispatchMessage(deps, { workerId: "w1", text: "hello", clientMsgId: "c1" });
    assert.deepEqual(r2.body, { ok: true, deduped: true });
    assert.equal(clientSends.length, 1);
  });

  it("duplicate clientMsgId while WORKING is not re-queued either", async () => {
    const { deps, queueRows } = buildDeps({ state: "WORKING" });
    await dispatchMessage(deps, { workerId: "w1", text: "later", clientMsgId: "c1", queueWhenBusy: true });
    const r2 = await dispatchMessage(deps, { workerId: "w1", text: "later", clientMsgId: "c1", queueWhenBusy: true });
    assert.deepEqual(r2.body, { ok: true, deduped: true });
    assert.equal(queueRows.length, 1);
  });

  it("failed dispatch rolls the claim back so a retry is not falsely deduped", async () => {
    const failing = buildDeps({ sendResult: { ok: false, status: 0, body: null } });
    await assert.rejects(() => dispatchMessage(failing.deps, { workerId: "w1", text: "hi", clientMsgId: "c1" }));
    assert.equal(failing.queueRows.length, 0);
    const ok = await dispatchMessage(
      { ...failing.deps, client: { sendMessage: async () => ({ ok: true, status: 200, body: { ok: true } }) } } as unknown as DispatchMessageDeps,
      { workerId: "w1", text: "hi", clientMsgId: "c1" },
    );
    assert.equal(ok.status, 200);
  });

  it("record carries clientMsgIds to the worker", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "hello", clientMsgId: "c1" });
    assert.deepEqual(sends[0].record, { as: "user_message", sentAt: 1234, clientMsgIds: ["c1"] });
  });

  it("recordClientMsgIds (drain path) ride the record without claiming", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, queueRows } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "a\n\nb", recordClientMsgIds: ["c1", "c2"] });
    assert.deepEqual(sends[0].record, { as: "user_message", sentAt: 1234, clientMsgIds: ["c1", "c2"] });
    // no claim row for the drain dispatch itself — only the unkeyed audit row
    assert.equal(queueRows.filter((r) => r.clientMsgId !== null).length, 0);
  });

  it("unkeyed same-text re-dispatch within the window leaves the forensic event", async () => {
    const { deps, events, clientSends } = buildDeps();
    await dispatchMessage(deps, { workerId: "w1", text: "selam" });
    await dispatchMessage(deps, { workerId: "w1", text: "selam" });
    const suspects = events.filter(
      (e) => e.type === "lifecycle" && (e.payload as { phase?: string }).phase === "duplicate_dispatch_suspected",
    );
    assert.equal(suspects.length, 1);
    // heuristic is log-only: both dispatches still went out
    assert.equal(clientSends.length, 2);
  });
});
