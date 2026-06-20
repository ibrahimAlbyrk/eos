import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getWorkerQueue: vi.fn(async () => ({ messages: [] })),
    dismissQueuedMessage: vi.fn(async () => ({ ok: true })),
  },
}));

import { api } from "../api/client.js";
import * as outbox from "./outboxStore.js";

const W = "w1";
const pills = () => outbox.itemsFor(W).filter((i) => i.state === "queued");
const bubbles = () => outbox.itemsFor(W).filter((i) => i.state !== "queued");

beforeEach(() => {
  outbox._reset();
  vi.clearAllMocks();
  api.getWorkerQueue.mockResolvedValue({ messages: [] });
  api.dismissQueuedMessage.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("send lifecycle", () => {
  it("busy send shows a pill immediately, before any response", () => {
    outbox.beginSend(W, { text: "hi", agentText: "hi", clientMsgId: "c1", busy: true });
    expect(pills()).toHaveLength(1);
    expect(bubbles()).toHaveLength(0);
  });

  it("idle send shows a bubble; queued response morphs it into a pill", () => {
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: false });
    expect(bubbles()).toHaveLength(1);
    outbox.settleSend(W, id, { ok: true, status: 202, body: { queued: true, queueId: 9 } });
    expect(pills()).toHaveLength(1);
    expect(pills()[0].queueId).toBe(9);
  });

  it("direct dispatch keeps the send-time ts on the dispatching bubble", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: false });
    vi.setSystemTime(5000);
    outbox.settleSend(W, id, { ok: true, status: 200, body: { ok: true } });
    expect(bubbles()[0].state).toBe("dispatching");
    expect(bubbles()[0].ts).toBe(1000);
  });

  it("deduped and rejected sends drop the item", () => {
    const a = outbox.beginSend(W, { text: "a", clientMsgId: "c1", busy: true });
    outbox.settleSend(W, a, { ok: true, status: 200, body: { ok: true, deduped: true } });
    const b = outbox.beginSend(W, { text: "b", clientMsgId: "c2", busy: false });
    outbox.settleSend(W, b, { ok: false, status: 409, body: { error: "x" } });
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  it("dismiss during the in-flight POST deletes the row once the 202 names it", () => {
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: true });
    outbox.dismissPill(W, id);
    expect(outbox.itemsFor(W)).toHaveLength(0);
    expect(api.dismissQueuedMessage).not.toHaveBeenCalled();
    outbox.settleSend(W, id, { ok: true, status: 202, body: { queued: true, queueId: 4 } });
    expect(api.dismissQueuedMessage).toHaveBeenCalledWith(W, 4);
  });

  it("an item dropped for any non-dismiss reason never cancels its server row", () => {
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: true });
    outbox.purgeAgent(W); // e.g. reconcile/TTL/purge removed the item mid-flight
    outbox.settleSend(W, id, { ok: true, status: 202, body: { queued: true, queueId: 4 } });
    expect(api.dismissQueuedMessage).not.toHaveBeenCalled();
  });

  it("dismissing a settled pill deletes its server row", () => {
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: true });
    outbox.settleSend(W, id, { ok: true, status: 202, body: { queued: true, queueId: 4 } });
    outbox.dismissPill(W, id);
    expect(outbox.itemsFor(W)).toHaveLength(0);
    expect(api.dismissQueuedMessage).toHaveBeenCalledWith(W, 4);
  });
});

describe("syncQueue", () => {
  it("turns a drained pill into a dispatching bubble stamped at detection time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const id = outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: true });
    outbox.settleSend(W, id, { ok: true, status: 202, body: { queued: true, queueId: 4 } });
    vi.setSystemTime(9000);
    await outbox.syncQueue(W);
    expect(pills()).toHaveLength(0);
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0].ts).toBe(9000);
    expect(bubbles()[0].clientMsgId).toBe("c1");
  });

  it("adopts the server row for a pill whose 202 is still in flight", async () => {
    outbox.beginSend(W, { text: "hi", agentText: "hi!", clientMsgId: "c1", busy: true });
    api.getWorkerQueue.mockResolvedValue({ messages: [{ id: 7, text: "hi!", ts: 50 }] });
    await outbox.syncQueue(W);
    expect(pills()[0].queueId).toBe(7);
    expect(pills()[0].clientMsgId).toBe("c1");
  });

  it("materializes pills for rows no local item knows (app reload)", async () => {
    api.getWorkerQueue.mockResolvedValue({ messages: [{ id: 3, text: "queued elsewhere", ts: 50 }] });
    await outbox.syncQueue(W);
    expect(pills()).toHaveLength(1);
    expect(pills()[0].queueId).toBe(3);
    expect(pills()[0].ts).toBe(50);
  });

  it("single-flight: a request landing mid-fetch re-runs after, so the fresh row wins", async () => {
    outbox.beginSend(W, { text: "hi", clientMsgId: "c1", busy: true });
    let resolveFirst;
    api.getWorkerQueue
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ messages: [{ id: 7, text: "hi", ts: 50 }] });
    const p1 = outbox.syncQueue(W);
    const p2 = outbox.syncQueue(W); // queued behind the in-flight fetch
    resolveFirst({ messages: [] }); // stale snapshot from before the insert
    await Promise.all([p1, p2]);
    expect(api.getWorkerQueue).toHaveBeenCalledTimes(2);
    expect(pills()).toHaveLength(1);
    expect(pills()[0].queueId).toBe(7);
  });

  it("a no-change snapshot does not notify subscribers", async () => {
    const spy = vi.fn();
    outbox.subscribe(spy);
    await outbox.syncQueue(W);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("reconcileEvents", () => {
  const userMsg = (text, clientMsgIds, ts = 100) =>
    ({ type: "user_message", ts, payload: JSON.stringify({ text, clientMsgIds }) });

  it("clientMsgId echo settles bubbles and pills alike", () => {
    const a = outbox.beginSend(W, { text: "a", clientMsgId: "ca", busy: true });
    const b = outbox.beginSend(W, { text: "b", clientMsgId: "cb", busy: false });
    outbox.settleSend(W, a, { ok: true, status: 202, body: { queued: true, queueId: 1 } });
    outbox.settleSend(W, b, { ok: true, status: 200, body: { ok: true } });
    outbox.reconcileEvents(W, [userMsg("a\n\nb", ["ca", "cb"])]);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  it("text prefix settles unkeyed bubbles but never pills", () => {
    const a = outbox.beginSend(W, { text: "deploy", busy: true });
    outbox.settleSend(W, a, { ok: true, status: 202, body: { queued: true, queueId: 1 } });
    outbox.addDispatched(W, { text: "deploy" });
    outbox.reconcileEvents(W, [userMsg("deploy", undefined)]);
    expect(pills()).toHaveLength(1); // an older same-text event must not kill a live pill
    expect(bubbles()).toHaveLength(0);
  });

  it("keyed items survive an older same-text message — only their id echo settles", () => {
    const a = outbox.beginSend(W, { text: "test", clientMsgId: "ca", busy: true });
    outbox.settleSend(W, a, { ok: true, status: 202, body: { queued: true, queueId: 1 } });
    const b = outbox.beginSend(W, { text: "test", clientMsgId: "cb", busy: false });
    outbox.settleSend(W, b, { ok: true, status: 200, body: { ok: true } });
    outbox.reconcileEvents(W, [userMsg("test", ["older-id"], 50)]);
    expect(pills()).toHaveLength(1);
    expect(bubbles()).toHaveLength(1);
    outbox.reconcileEvents(W, [userMsg("test", ["ca", "cb"], 200)]);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  it("TTL sweeps a pill whose settle path broke (no page reload needed)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    outbox.beginSend(W, { text: "stuck", clientMsgId: "cs", busy: true });
    vi.setSystemTime(1000 + 11 * 60 * 1000);
    outbox.reconcileEvents(W, [userMsg("unrelated", undefined)]);
    expect(pills()).toHaveLength(0);
  });

  it("delivery_failed recorded after the send drops the bubble", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    outbox.addDispatched(W, { text: "lost message" });
    outbox.reconcileEvents(W, [
      { type: "lifecycle", ts: 2000, payload: JSON.stringify({ phase: "delivery_failed", text: "lost message" }) },
    ]);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  it("TTL sweeps a bubble nothing ever settled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    outbox.addDispatched(W, { text: "orphan" });
    vi.setSystemTime(1000 + 11 * 60 * 1000);
    outbox.reconcileEvents(W, [userMsg("unrelated", undefined)]);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  // The "/clear" optimistic bubble is keyed but never gets a user_message echo
  // (the slash command produces no chat event), so the clear boundary must drop it.
  it("conversation_cleared drops optimistic items from before the clear", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    outbox.beginSend(W, { text: "/clear", clientMsgId: "cc", busy: false });
    outbox.reconcileEvents(W, [{ type: "conversation_cleared", ts: 2000, payload: null }]);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });

  it("a message sent AFTER a clear survives the clear boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    outbox.beginSend(W, { text: "fresh start", clientMsgId: "cf", busy: false });
    outbox.reconcileEvents(W, [{ type: "conversation_cleared", ts: 2000, payload: null }]);
    expect(outbox.itemsFor(W)).toHaveLength(1);
  });
});

describe("cancel / purge", () => {
  it("cancelQueued drops pills and keeps bubbles", () => {
    const a = outbox.beginSend(W, { text: "a", clientMsgId: "ca", busy: true });
    outbox.settleSend(W, a, { ok: true, status: 202, body: { queued: true, queueId: 1 } });
    outbox.addDispatched(W, { text: "boot" });
    outbox.cancelQueued(W);
    expect(pills()).toHaveLength(0);
    expect(bubbles()).toHaveLength(1);
  });

  it("purgeAgent clears everything for the worker", () => {
    outbox.beginSend(W, { text: "a", busy: true });
    outbox.addDispatched(W, { text: "b" });
    outbox.purgeAgent(W);
    expect(outbox.itemsFor(W)).toHaveLength(0);
  });
});
