// A click on a visual answer's send action: the model reads "[view action] <label>"
// plus a JSON line; the chat stores the label and the action (the reply chip) — on
// a direct dispatch and through the busy queue's drain alike.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import { drainQueuedMessages } from "../use-cases/DrainQueuedMessages.ts";
import { viewActionTurn } from "../domain/view-action.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { AgentBackend, AgentSession } from "../ports/AgentBackend.ts";
import type { MessageRecord } from "../ports/WorkerClient.ts";
import type { ViewAction } from "../../../contracts/src/genui/spec.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

const ACTION: ViewAction = {
  viewId: "v_AbCdEfGh1234",
  actionId: "book",
  label: "Book a table",
  viewTitle: "Kadıköy tonight",
  item: { id: "moda", name: "Moda Kıyı" },
  state: { party: 2 },
};
const MODEL_TEXT = '[view action] Book a table\n{"viewId":"v_AbCdEfGh1234","actionId":"book","item":{"id":"moda","name":"Moda Kıyı"},"state":{"party":2}}';
const STORED = { viewId: "v_AbCdEfGh1234", label: "Book a table", viewTitle: "Kadıköy tonight" };

function setup(state = "IDLE") {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sends: Array<{ text: string; record?: MessageRecord }> = [];
  const queue = fakeQueue();
  const row = { id: "w1", state, port: null, pid: null, backend_kind: "inproc", is_orchestrator: 0 };
  const session = {
    workerId: "w1",
    capabilities: { reportsMessageEvents: false },
    sendMessage: async (text: string, record?: MessageRecord) => { sends.push({ text, record }); return { ok: true, status: 200, body: { ok: true } }; },
  } as unknown as AgentSession;
  const backend = {
    kind: "inproc",
    descriptor: { processModel: "in-process", capabilities: {} },
    start: async () => session,
    attach: () => session,
  } as unknown as AgentBackend;
  const deps = {
    workers: { findById: () => row as unknown as WorkerRow, updateState: () => {}, setTurnStartedAt: () => {} },
    events: {
      append: (_id: string, _ts: number, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return events.length; },
      listByType: () => [],
    },
    bus: { publish: () => {} },
    clock: { now: () => 1000 },
    queue: queue.repo,
    client: { sendMessage: async () => ({ ok: true, status: 200, body: {} }) },
    backends: { has: (k: string) => k === "inproc", get: () => backend },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
  } as unknown as DispatchMessageDeps;
  return { deps, events, sends, queue, row };
}

describe("dispatchMessage — view actions", () => {
  it("the model reads the label and the payload; the chat stores the label and the action", async () => {
    const { deps, events, sends } = setup();
    await dispatchMessage(deps, { workerId: "w1", text: "Book a table", viewAction: ACTION, origin: "view-action" });
    assert.deepEqual(sends.map((s) => s.text), [MODEL_TEXT]);
    const chat = events.filter((e) => e.type === "user_message");
    assert.deepEqual(chat.map((e) => e.payload), [{ text: "Book a table", action: STORED }]);
  });

  it("a busy worker queues it and the drain delivers the same turn", async () => {
    const { deps, events, sends, queue, row } = setup("WORKING");
    const res = await dispatchMessage(deps, { workerId: "w1", text: "Book a table", viewAction: ACTION, queueWhenBusy: true, clientMsgId: "c-1" });
    assert.equal(res.status, 202);
    assert.equal(sends.length, 0);
    assert.deepEqual(queue.repo.listPending("w1").map((q) => ({ text: q.text, displayText: q.displayText, action: q.action })), [
      { text: MODEL_TEXT, displayText: "Book a table", action: STORED },
    ]);

    row.state = "IDLE";
    const outcome = await drainQueuedMessages(
      { workers: deps.workers, queue: deps.queue, clock: deps.clock, log: deps.log, clearTurnSettle: () => {}, dispatch: (input) => dispatchMessage(deps, input) },
      { workerId: "w1" },
    );
    assert.equal(outcome, "dispatched");
    assert.deepEqual(sends.map((s) => s.text), [MODEL_TEXT]);
    const chat = events.filter((e) => e.type === "user_message");
    assert.deepEqual(chat.map((e) => e.payload), [{ text: "Book a table", clientMsgIds: ["c-1"], action: STORED }]);
  });

  it("a plain message carries no action", async () => {
    const { deps, events, sends } = setup();
    await dispatchMessage(deps, { workerId: "w1", text: "hello" });
    assert.deepEqual(sends.map((s) => s.text), ["hello"]);
    assert.deepEqual(events.filter((e) => e.type === "user_message").map((e) => e.payload), [{ text: "hello" }]);
  });
});

describe("viewActionTurn", () => {
  it("adds the sent text when it says more than the label, and drops empty state", () => {
    const t = viewActionTurn({ viewId: "v_AbCdEfGh1234", actionId: "fix", label: "Fix with a worker", state: {} }, "Fix all 3 failing tests with a worker");
    assert.equal(t.text, '[view action] Fix with a worker\nFix all 3 failing tests with a worker\n{"viewId":"v_AbCdEfGh1234","actionId":"fix"}');
    assert.equal(t.displayText, "Fix with a worker");
    assert.deepEqual(t.action, { viewId: "v_AbCdEfGh1234", label: "Fix with a worker" });
  });

  it("keeps an item given by id", () => {
    const t = viewActionTurn({ viewId: "v_AbCdEfGh1234", actionId: "open", label: "Open", item: "moda" }, "Open");
    assert.equal(t.text, '[view action] Open\n{"viewId":"v_AbCdEfGh1234","actionId":"open","item":"moda"}');
  });
});
