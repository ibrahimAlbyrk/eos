import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import { drainQueuedMessages } from "../use-cases/DrainQueuedMessages.ts";
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
  const descriptor = { processModel: kind === "inproc" ? "in-process" : "out-of-process" } as unknown as AgentBackend["descriptor"];
  return { kind, descriptor, start: async () => session, attach: () => session };
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

  it("queueWhenBusy + IDLE with a pending backlog queues — never overtakes the drain", async () => {
    // The live race: msg lands in the Stop→drain window (state already IDLE,
    // rows still pending) and a direct dispatch would reach the PTY before
    // the drained backlog. It must queue behind the rows instead.
    const { deps, clientSends, queueRows, published } = buildDeps({ state: "WORKING" });
    await dispatchMessage(deps, { workerId: "w1", text: "first", clientMsgId: "c1", queueWhenBusy: true });
    (deps.workers.findById("w1") as { state: string }).state = "IDLE";
    const r = await dispatchMessage(deps, { workerId: "w1", text: "second", clientMsgId: "c2", queueWhenBusy: true });
    assert.equal(r.status, 202);
    assert.deepEqual(r.body, { ok: true, queued: true, queueId: 2 });
    assert.equal(clientSends.length, 0);
    assert.equal(queueRows.filter((row) => row.dispatchedAt === null).length, 2);
    // the enqueue signal still fires so the drain picks both up immediately
    assert.ok(published.some((p) => p.topic === "worker:change" && (p.payload as { queued?: boolean }).queued === true));
  });

  it("queueWhenBusy + IDLE with only ledger rows (no pending) still dispatches directly", async () => {
    const { deps, clientSends } = buildDeps();
    await dispatchMessage(deps, { workerId: "w1", text: "first", clientMsgId: "c1" });
    const r = await dispatchMessage(deps, { workerId: "w1", text: "second", clientMsgId: "c2", queueWhenBusy: true });
    assert.equal(r.status, 200);
    assert.equal(clientSends.length, 2);
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

  it("clears the settle window only on an actual dispatch — never on enqueue or dedup", async () => {
    const cleared: string[] = [];
    const working = buildDeps({ state: "WORKING" });
    (working.deps as { clearTurnSettle?: (id: string) => void }).clearTurnSettle = (id) => cleared.push(id);
    await dispatchMessage(working.deps, { workerId: "w1", text: "later", clientMsgId: "c1", queueWhenBusy: true });
    assert.deepEqual(cleared, []); // enqueue must not re-open the trailing-jsonl gate

    const idle = buildDeps();
    (idle.deps as { clearTurnSettle?: (id: string) => void }).clearTurnSettle = (id) => cleared.push(id);
    await dispatchMessage(idle.deps, { workerId: "w1", text: "now", clientMsgId: "c2" });
    assert.deepEqual(cleared, ["w1"]);
    await dispatchMessage(idle.deps, { workerId: "w1", text: "now", clientMsgId: "c2" });
    assert.deepEqual(cleared, ["w1"]); // deduped repeat is not a new turn
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

describe("dispatchMessage — agent-plane envelopes (report/directive/peer)", () => {
  const byType = (events: AppendedEvent[], type: string) => events.filter((e) => e.type === type);

  it("worker_report, self-reporting parent (claude-cli): record rides, no daemon append", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, {
      workerId: "w1", text: "[worker alice (w2)] reported:\nbody", displayText: "body",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
    });
    assert.deepEqual(byType(events, "worker_report"), []);
    assert.deepEqual(sends, [{
      text: "[worker alice (w2)] reported:\nbody",
      record: { as: "worker_report", fromWorker: "w2", workerName: "alice", displayText: "body", sentAt: 1234 },
    }]);
  });

  it("worker_report, non-reporting parent (in-process): daemon append of the bare body, no record", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, {
      workerId: "w1", text: "[worker alice (w2)] reported:\nbody", displayText: "body",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
    });
    assert.deepEqual(byType(events, "worker_report"), [
      { type: "worker_report", payload: { text: "body", fromWorker: "w2", workerName: "alice" } },
    ]);
    // the session still receives the routing wrapper (what the model reads)
    assert.deepEqual(sends, [{ text: "[worker alice (w2)] reported:\nbody", record: undefined }]);
  });

  it("orchestrator_message, in-process worker: daemon append with parent routing", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, {
      workerId: "w1", text: "do the thing",
      envelope: { kind: "orchestrator_message", fromParent: "o1", parentName: "boss" },
    });
    assert.deepEqual(byType(events, "orchestrator_message"), [
      { type: "orchestrator_message", payload: { text: "do the thing", fromParent: "o1", parentName: "boss" } },
    ]);
  });

  it("peer_request, in-process peer: daemon append of the bare question", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, {
      workerId: "w1", text: "[Peer request from bob]\nwhat is X?", displayText: "what is X?",
      envelope: { kind: "peer_request", fromWorker: "w3", fromName: "bob" },
    });
    assert.deepEqual(byType(events, "peer_request"), [
      { type: "peer_request", payload: { text: "what is X?", fromWorker: "w3", fromName: "bob" } },
    ]);
  });

  it("envelope kind drives the state-transition reason", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, {
      workerId: "w1", text: "r", envelope: { kind: "worker_report", fromWorker: "w2" },
    });
    const state = events.find((e) => e.type === "state");
    assert.equal((state?.payload as { reason?: string }).reason, "worker_report");
  });

  it("missing optional name falls back to the id (parity with the PTY emitter)", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, {
      workerId: "w1", text: "wrap", displayText: "body",
      envelope: { kind: "worker_report", fromWorker: "w2" },
    });
    assert.deepEqual(byType(events, "worker_report"), [
      { type: "worker_report", payload: { text: "body", fromWorker: "w2", workerName: "w2" } },
    ]);
  });

  it("a report to a busy parent queues, persisting envelope + displayText for the drain", async () => {
    const { deps, clientSends, queueRows } = buildDeps({ state: "WORKING" });
    const r = await dispatchMessage(deps, {
      workerId: "w1", text: "[worker alice (w2)] reported:\nbody", displayText: "body",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
      queueWhenBusy: true,
    });
    assert.equal(r.status, 202);
    assert.equal(clientSends.length, 0);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].dispatchedAt, null);
    assert.deepEqual(queueRows[0].envelope, { kind: "worker_report", fromWorker: "w2", workerName: "alice" });
    assert.equal(queueRows[0].displayText, "body");
    // tagged agent-plane → the pill endpoint (listPendingUserPlane) hides it
    // while the parent is mid-turn; it still drains into the transcript.
    assert.equal(queueRows[0].plane, "agent");
  });

  it("orchestrator directive to a busy worker queues (agent-plane), envelope persisted for the drain", async () => {
    // The reported bug: a directive to a WORKING worker took the direct mid-turn
    // PTY steer (no queueWhenBusy), which skips ACK/retry and was silently lost.
    // It must queue like worker_report and drain at the worker's next IDLE.
    const { deps, clientSends, queueRows } = buildDeps({ state: "WORKING" });
    const r = await dispatchMessage(deps, {
      workerId: "w1", text: "redirect: do X instead",
      envelope: { kind: "orchestrator_message", fromParent: "o1", parentName: "boss" },
      queueWhenBusy: true,
    });
    assert.equal(r.status, 202);
    assert.equal(clientSends.length, 0);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].dispatchedAt, null);
    assert.deepEqual(queueRows[0].envelope, { kind: "orchestrator_message", fromParent: "o1", parentName: "boss" });
    // agent-plane → never surfaces as a user pill while the worker is mid-turn
    assert.equal(queueRows[0].plane, "agent");
  });

  it("a plain dashboard message queued behind a busy worker is user-plane (a pill)", async () => {
    const { deps, queueRows } = buildDeps({ state: "WORKING" });
    await dispatchMessage(deps, { workerId: "w1", text: "later", clientMsgId: "c1", queueWhenBusy: true });
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].plane, "user");
  });

  it("a report dispatched directly to an IDLE parent leaves exactly ONE record, agent-plane", async () => {
    // Direct path (no busy-hold): the unkeyed ledger row is the report's only
    // record, so it must carry the agent plane — not default to 'user' (a phantom
    // pill). One record, agent-plane.
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, queueRows } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc" });
    await dispatchMessage(deps, {
      workerId: "w1", text: "[worker alice (w2)] reported:\nbody", displayText: "body",
      envelope: { kind: "worker_report", fromWorker: "w2", workerName: "alice" },
      queueWhenBusy: true, origin: "report",
    });
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].plane, "agent");
  });

  it("a report to a BUSY orchestrator (busy-hold → drain) leaves EXACTLY ONE queued_messages record", async () => {
    // The real duplication: ROW1 = busy-hold (agent, pending); the drain then
    // re-dispatches it (origin=queue-drain) and the audit-ledger insert produced
    // ROW2 — pure duplication (both NULL client_msg_id never dedup). The fix
    // skips the ledger insert on a drain, so the drained-then-dispatched ROW1 is
    // the sole record. Re-plane-only would leave TWO agent rows here.
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, queueRows } = buildDeps({ backend: fakeBackend("inproc", false, sends), backendKind: "inproc", state: "WORKING" });
    const envelope = { kind: "worker_report" as const, fromWorker: "w2", workerName: "alice" };

    // 1) report arrives while the parent is WORKING → held (ROW1, agent, pending).
    await dispatchMessage(deps, {
      workerId: "w1", text: "[worker alice (w2)] reported:\nbody", displayText: "body",
      envelope, queueWhenBusy: true, origin: "report",
    });
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].dispatchedAt, null);

    // 2) parent reaches IDLE → the daemon drains the held row.
    (deps.workers.findById("w1") as { state: string }).state = "IDLE";
    const outcome = await drainQueuedMessages(
      { workers: deps.workers, queue: deps.queue, clock: deps.clock, log: deps.log, clearTurnSettle: () => {}, dispatch: (input) => dispatchMessage(deps, input) },
      { workerId: "w1" },
    );

    assert.equal(outcome, "dispatched");
    assert.equal(queueRows.length, 1);              // EXACTLY one record for one report
    assert.equal(queueRows[0].plane, "agent");
    assert.equal(queueRows[0].dispatchedAt, 1234);  // the held row, now dispatched
  });
});
