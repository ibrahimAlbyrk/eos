import { createFakeAgentBackend, type FakeAgentBackend } from "../backends/FakeAgentBackend.ts";
import { createInProcessBackend, type InProcessBackend, type InProcessEnv } from "../backends/InProcessBackend.ts";
import type { ModelTurn } from "../../../core/src/ports/ModelClient.ts";
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
