import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { AgentBackend, AgentSession } from "../ports/AgentBackend.ts";
import type { MessageRecord } from "../ports/WorkerClient.ts";

interface AppendedEvent { type: string; payload: unknown }

function buildDeps(opts: {
  backend?: AgentBackend;
  backendKind?: string | null;
} = {}): {
  deps: DispatchMessageDeps;
  events: AppendedEvent[];
  clientSends: Array<{ text: string; record?: MessageRecord }>;
} {
  const events: AppendedEvent[] = [];
  const clientSends: Array<{ text: string; record?: MessageRecord }> = [];
  const row = {
    id: "w1", state: "IDLE", port: 7501, pid: 42,
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
    bus: { publish: () => {} },
    clock: { now: () => 1234 },
    client: {
      sendMessage: async (_port: number, text: string, record?: MessageRecord) => {
        clientSends.push({ text, record });
        return { ok: true, status: 200, body: { ok: true } };
      },
    },
    ...(opts.backend
      ? { backends: { has: (k: string) => k === opts.backend!.kind, get: () => opts.backend! } }
      : {}),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
  } as unknown as DispatchMessageDeps;

  return { deps, events, clientSends };
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
    assert.deepEqual(sends, [{ text: "hello", record: { as: "user_message" } }]);
  });

  it("self-reporting backend: displayText rides in the record, full text to the PTY", async () => {
    const sends: Array<{ text: string; record?: MessageRecord }> = [];
    const { deps, events } = buildDeps({ backend: fakeBackend("claude-cli", true, sends) });
    await dispatchMessage(deps, { workerId: "w1", text: "full action prompt", displayText: "/commit" });
    assert.deepEqual(userMessages(events), []);
    assert.deepEqual(sends, [{ text: "full action prompt", record: { as: "user_message", displayText: "/commit" } }]);
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
    assert.deepEqual(clientSends, [{ text: "hello", record: { as: "user_message" } }]);
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
