import { createFakeAgentBackend, type FakeAgentBackend } from "../backends/FakeAgentBackend.ts";
import { createInProcessBackend, type InProcessBackend, type InProcessEnv } from "../backends/InProcessBackend.ts";
import type { ModelMessage, ModelTurn } from "../../../core/src/ports/ModelClient.ts";
import type { ConversationStore } from "../../../core/src/ports/ConversationStore.ts";
import { randomIdGenerator } from "../id/RandomIdGenerator.ts";
import { runAgentBackendConformance } from "./agent-backend-conformance.ts";

// Fake — the reference adapter.
runAgentBackendConformance("FakeAgentBackend", () => createFakeAgentBackend(), {
  expectHandleKind: "inproc",
  triggerExit: (be, id) => (be as FakeAgentBackend).exit(id, 0),
});

// InProcess — a real second adapter driven by a fake model (no API key, no billing).
const endTurn: ModelTurn = { text: "ok", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
const fakeEnv = (): InProcessEnv => ({
  model: { async createTurn() { return endTurn; } },
  tools: new Map(),
  gate: { async decide() { return { allow: true }; } },
});
runAgentBackendConformance("InProcessBackend(fakeModel)", () => createInProcessBackend("fake-api", fakeEnv), {
  expectHandleKind: "inproc",
  settle: (be, id) => (be as InProcessBackend).whenSettled(id),
  triggerExit: (be, id) => be.attach(id, { kind: "inproc", ref: id }).stop(),
});

// InProcess with the DURABLE deps (ConversationStore + IdGenerator) wired — the M3
// production shape that emits `session ready+sessionId` and persists each turn. The 5
// universal invariants must stay green here too: durability is additive (a session id
// + persistence), it must not change the mandatory AgentSession surface. The no-deps
// run above proves the conformance shape when durability is absent; this proves it
// holds when durability is ON. (The ready+sessionId emission + persist/resume behavior
// itself is asserted in InProcessBackend-durability.test.ts.)
const memStore = (): ConversationStore => {
  const m = new Map<string, ModelMessage[]>();
  return {
    save: (_w, id, msgs) => { m.set(id, msgs); },
    load: (id) => m.get(id) ?? null,
    delete: (id) => { m.delete(id); },
  };
};
runAgentBackendConformance(
  "InProcessBackend(durable: store+ids)",
  () => createInProcessBackend("anthropic-api", fakeEnv, { store: memStore(), ids: randomIdGenerator }),
  {
    expectHandleKind: "inproc",
    settle: (be, id) => (be as InProcessBackend).whenSettled(id),
    triggerExit: (be, id) => be.attach(id, { kind: "inproc", ref: id }).stop(),
  },
);
