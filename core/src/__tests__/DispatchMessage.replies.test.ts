import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import { drainQueuedMessages } from "../use-cases/DrainQueuedMessages.ts";
import { excerpt } from "../domain/message-id.ts";
import { NotFoundError } from "../errors/index.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

function harness(state = "IDLE") {
  const rows: WorkerEventRow[] = [];
  const sends: string[] = [];
  const queue = fakeQueue();
  const worker = { id: "w1", state, port: null, pid: null, backend_kind: "inproc", is_orchestrator: 0 };
  const session = {
    capabilities: {},
    sendMessage: async (text: string) => { sends.push(text); return { ok: true, status: 200, body: { ok: true } }; },
  };
  const backend = { kind: "inproc", descriptor: { processModel: "in-process", capabilities: {} }, start: async () => session, attach: () => session };
  let seq = 0;
  const append = (workerId: string, ts: number, type: string, payload: unknown): number => {
    rows.push({ id: rows.length + 1, worker_id: workerId, ts, type, payload: JSON.stringify(payload) });
    return rows.length;
  };
  const deps = {
    workers: { findById: () => worker, updateState: () => {}, setTurnStartedAt: () => {} },
    events: {
      append,
      findById: (workerId: string, id: number) => rows.find((r) => r.id === id && r.worker_id === workerId) ?? null,
      listByType: (workerId: string, type: string) => rows.filter((r) => r.worker_id === workerId && r.type === type),
    },
    bus: { publish: () => {} },
    clock: { now: () => 1000 },
    queue: queue.repo,
    client: { sendMessage: async () => { throw new Error("unused"); } },
    backends: { has: (k: string) => k === "inproc", get: () => backend },
    messageIds: { nextInbound: () => ++seq },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
  } as unknown as DispatchMessageDeps;
  const chat = () => rows.filter((r) => r.type === "user_message").map((r) => JSON.parse(r.payload ?? "null"));
  const seed = (type: string, payload: unknown) => append("w1", 1, type, payload);
  const seedAssistant = (text: string, msgId: string) =>
    seed("agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text, msgId }] });
  return { deps, sends, chat, seed, seedAssistant, worker, queueRows: queue.rows };
}

const LONG = "Olur, önce üç farklı tatlı dişi kedi tasarımı hazırlayıp göstereceğim ".repeat(5).trim();

describe("dispatchMessage — message ids", () => {
  it("an operator message gets a <msg id> head; its chat row records the id", async () => {
    const h = harness();
    await dispatchMessage(h.deps, { workerId: "w1", text: "hello" });
    await dispatchMessage(h.deps, { workerId: "w1", text: "again" });
    assert.deepEqual(h.sends, ['<msg id="1"/>\nhello', '<msg id="2"/>\nagain']);
    assert.deepEqual(h.chat(), [{ text: "hello", msgId: "1" }, { text: "again", msgId: "2" }]);
  });

  it("an agent-plane message carries its id as a wrapper attribute", async () => {
    const h = harness();
    await dispatchMessage(h.deps, {
      workerId: "w1", text: "do it", envelope: { kind: "orchestrator_message", fromParent: "o1", parentName: "orch" },
    });
    assert.equal(h.sends[0], '<agent_message from="orch" from-id="o1" id="1">\ndo it\n</agent_message>');
  });

  it("a leading slash command takes no id, so the agent still parses it", async () => {
    const h = harness();
    await dispatchMessage(h.deps, { workerId: "w1", text: "/review src" });
    assert.deepEqual(h.sends, ["/review src"]);
    assert.deepEqual(h.chat(), [{ text: "/review src" }]);
  });
});

describe("dispatchMessage — replies", () => {
  it("to an inbound message the model saw → the bare id + a snapshot on the chat row", async () => {
    const h = harness();
    const target = h.seed("user_message", { text: "first", msgId: "4" });
    await dispatchMessage(h.deps, { workerId: "w1", text: "yes", replyTo: { rowId: target } });
    assert.equal(h.sends[0], '<msg id="1"/>\n<reply_to id="4"/>\nyes');
    assert.deepEqual(h.chat().at(-1), { text: "yes", msgId: "1", replyTo: { rowId: target, msgId: "4", role: "user", excerpt: "first" } });
  });

  it("to an assistant message → its id plus an excerpt", async () => {
    const h = harness();
    const target = h.seedAssistant(LONG, "3.1");
    await dispatchMessage(h.deps, { workerId: "w1", text: "1 olsun", replyTo: { rowId: target } });
    assert.equal(h.sends[0], `<msg id="1"/>\n<reply_to id="3.1">${excerpt(LONG)}</reply_to>\n1 olsun`);
  });

  it("to a message before the last compaction → its full text", async () => {
    const h = harness();
    const target = h.seedAssistant(LONG, "3.1");
    h.seed("compaction_completed", { summary: "…" });
    await dispatchMessage(h.deps, { workerId: "w1", text: "1 olsun", replyTo: { rowId: target } });
    assert.equal(h.sends[0], `<msg id="1"/>\n<reply_to id="3.1">${LONG}</reply_to>\n1 olsun`);
  });

  it("a missing target fails a live send", async () => {
    const h = harness();
    await assert.rejects(dispatchMessage(h.deps, { workerId: "w1", text: "yes", replyTo: { rowId: 99 } }), NotFoundError);
    assert.deepEqual(h.sends, []);
  });

  it("a missing target on the queue drain degrades to a plain message", async () => {
    const h = harness();
    await dispatchMessage(h.deps, { workerId: "w1", text: "yes", replyTo: { rowId: 99 }, origin: "queue-drain" });
    assert.deepEqual(h.sends, ['<msg id="1"/>\nyes']);
  });

  it("a queued reply keeps its target and resolves at delivery", async () => {
    const h = harness("WORKING");
    const target = h.seedAssistant("Pick one", "2.1");
    const r = await dispatchMessage(h.deps, { workerId: "w1", text: "1", clientMsgId: "c1", queueWhenBusy: true, replyTo: { rowId: target } });
    assert.equal(r.status, 202);
    assert.deepEqual(h.queueRows[0].replyTo, { rowId: target });

    h.worker.state = "IDLE";
    const outcome = await drainQueuedMessages({
      workers: h.deps.workers, queue: h.deps.queue, clock: h.deps.clock, log: h.deps.log,
      clearTurnSettle: () => {},
      dispatch: (input) => dispatchMessage(h.deps, input),
    }, { workerId: "w1" });
    assert.equal(outcome, "dispatched");
    assert.equal(h.sends[0], '<msg id="1"/>\n<reply_to id="2.1">Pick one</reply_to>\n1');
  });

  it("is ignored on a slash command", async () => {
    const h = harness();
    const target = h.seed("user_message", { text: "first", msgId: "4" });
    await dispatchMessage(h.deps, { workerId: "w1", text: "/compact now", replyTo: { rowId: target } });
    assert.deepEqual(h.sends, ["/compact now"]);
  });
});
