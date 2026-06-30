// M5 — external MCP servers on the in-process API lane (§5c). Two faces:
//   1. connectRuntimeMcpTools — the wrap/fail-soft unit: a resolved server map is
//      connected, listed, and projected to mcp__<server>__<tool> RuntimeTools; a
//      dead server is dropped (fail-soft); close() tears every survivor down.
//   2. End-to-end through the real in-process env factory + InProcessBackend: an
//      API worker LISTS (the model sees the item) + CALLS the tool (it passes the
//      shared policy gate as the always-allow `mcp` category and dispatches to the
//      client with the UNPREFIXED remote name), and the session-scoped connection
//      is closed at stop(). A dead server never sinks the session.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { connectRuntimeMcpTools, type RuntimeMcpToolset } from "../backends/runtime-mcp.ts";
import { createInProcessEnvFactory } from "../backends/in-process-env.ts";
import { createInProcessBackend } from "../../infra/src/backends/InProcessBackend.ts";
import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../../core/src/services/PolicyGatewayService.ts";
import type { Policy } from "../../core/src/domain/policy.ts";
import { makePolicyToolGate, type PolicyDecider } from "../backends/PolicyToolGate.ts";
import type { McpToolClient } from "../../core/src/ports/McpToolClient.ts";
import type { ModelClient, ModelTurn } from "../../core/src/ports/ModelClient.ts";
import type { AgentEvent } from "../../contracts/src/canonical.ts";
import type { AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";

// A fake MCP server's client: one `echo` tool that records its calls. connect/
// close track lifecycle so the tests can assert open + teardown.
function fakeMcpClient(rec: { calls: Array<{ name: string; args: Record<string, unknown> }>; closed: boolean }): McpToolClient {
  return {
    async connect() {},
    async listTools() {
      return [{ name: "echo", description: "echo the input back", inputSchema: { type: "object", properties: { v: { type: "number" } } } }];
    },
    async callTool(name, args) {
      rec.calls.push({ name, args });
      return `echoed ${JSON.stringify(args)}`;
    },
    async close() {
      rec.closed = true;
    },
  };
}

// The real in-process gate (the SAME PolicyGatewayService the SDK/CLI lanes use),
// in a restrictive mode so "mcp always-allow" is a real signal (a shell would ask).
function realGate(workerId: string) {
  const policy: Policy = { default: "ask", ttlMs: 1000, rules: [] };
  const deps = {
    pending: { insert() {}, findById: () => null, listUnresolved: () => [], resolve: () => true, sweepExpired: () => 0, deleteByWorker() {} },
    events: { append: () => 1, patchPayload() {}, list: () => [], deleteByWorker() {} },
    bus: { publish() {}, subscribe: () => () => {} },
    clock: { now: () => 1000 },
    ids: { newPendingId: () => "p1" },
    modeResolver: { resolveFor: () => "acceptEdits" },
    toolScopeResolver: { resolveFor: () => null },
    getPolicy: () => policy,
  } as unknown as PolicyGatewayServiceDeps;
  const svc = new PolicyGatewayService(deps);
  const decider: PolicyDecider = {
    async decide(i) {
      const d = await svc.decide(i);
      return { behavior: d.behavior === "allow" ? "allow" : "deny", message: d.message, updatedInput: d.updatedInput };
    },
  };
  return makePolicyToolGate(workerId, decider);
}

function fakeModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}

function spec(workerId: string): AgentLaunchSpec {
  return { workerId, cwd: "/tmp", model: "fake", prompt: "go", persistent: false, parentId: null, isOrchestrator: false };
}

describe("connectRuntimeMcpTools — wrap + fail-soft", () => {
  it("connects each server, lists its tools, and names them mcp__<server>__<tool>", async () => {
    const rec = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    const set = await connectRuntimeMcpTools({ fake: { command: "x" } }, () => fakeMcpClient(rec));

    assert.deepEqual(set.items.map((i) => i.name), ["mcp__fake__echo"]);
    assert.ok(set.tools.has("mcp__fake__echo"));
    // The remote tool's schema is surfaced verbatim for the model.
    assert.deepEqual(set.items[0].schema, { type: "object", properties: { v: { type: "number" } } });

    // execute dispatches to the client with the UNPREFIXED remote name.
    const out = await set.tools.get("mcp__fake__echo")!.execute({ v: 7 });
    assert.equal(out, 'echoed {"v":7}');
    assert.deepEqual(rec.calls, [{ name: "echo", args: { v: 7 } }]);

    await set.close();
    assert.equal(rec.closed, true);
  });

  it("drops a server that fails connect (fail-soft) and keeps the rest", async () => {
    const live = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    const dead: McpToolClient = {
      async connect() { throw new Error("ECONNREFUSED"); },
      async listTools() { return []; },
      async callTool() { return ""; },
      async close() {},
    };
    const warnings: unknown[] = [];
    const set = await connectRuntimeMcpTools(
      { dead: { command: "no" }, live: { command: "yes" } },
      (name) => (name === "dead" ? dead : fakeMcpClient(live)),
      { warn: (_m, meta) => warnings.push(meta) },
    );

    assert.deepEqual(set.items.map((i) => i.name), ["mcp__live__echo"]);
    assert.ok(!set.tools.has("mcp__dead__echo"));
    assert.equal(warnings.length, 1);
  });
});

describe("API-lane MCP — end-to-end through the in-process backend", () => {
  // The model is scripted to call the external tool, then end the turn.
  const turns: ModelTurn[] = [
    { toolCalls: [{ callId: "c1", name: "mcp__fake__echo", input: { v: 42 } }], stopReason: "tool_use" },
    { text: "done", toolCalls: [], stopReason: "end_turn" },
  ];

  function startWorker(workerId: string, makeMcp: () => Promise<RuntimeMcpToolset>) {
    const events: AgentEvent[] = [];
    let offeredItems: { name: string }[] = [];
    const factory = createInProcessEnvFactory({
      assembleSystem: () => null,
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: (id) => realGate(id),
      resolveMcpTools: () => makeMcp(),
      buildModelClient: ({ items }) => { offeredItems = items; return fakeModel(turns); },
    });
    const be = createInProcessBackend("fake-api", factory);
    return { be, events, started: be.start(spec(workerId), { onEvent: (e) => events.push(e) }), itemsRef: () => offeredItems };
  }

  it("an API worker lists + calls a fake MCP tool, gated mcp-always-allow", async () => {
    const rec = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    const { be, events, started, itemsRef } = startWorker("w-mcp", () => connectRuntimeMcpTools({ fake: { command: "x" } }, () => fakeMcpClient(rec)));
    const session = await started;
    await be.whenSettled("w-mcp");

    // LIST: the model was offered the external tool on its surface.
    assert.ok(itemsRef().some((i) => i.name === "mcp__fake__echo"), "model is offered mcp__fake__echo");
    assert.ok(session.isAlive());
    // GATE: the always-allow `mcp` category lets it through the real policy gate
    // (under acceptEdits a shell would ASK — so this is a real allow signal).
    assert.equal((await realGate("w-mcp").decide("mcp__fake__echo", { v: 42 })).allow, true);
    // CALL: the tool actually ran, dispatched with the UNPREFIXED remote name.
    assert.deepEqual(rec.calls, [{ name: "echo", args: { v: 42 } }]);
    // The tool_result text flowed back; the turn completed.
    const tags = events.map((e) => (e.type === "turn" ? `turn:${e.phase}` : e.type === "message" ? `msg:${e.blocks[0].type}` : e.type));
    assert.ok(tags.includes("turn:ended"));
    assert.ok(events.some((e) => e.type === "message" && e.blocks.some((b) => b.type === "tool_result" && b.content.includes("echoed"))));

    // LIFECYCLE: stop() closes the session-scoped MCP connection.
    session.stop();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(rec.closed, true, "stop() closes the MCP connection");
  });

  it("a dead MCP server is dropped; the session still completes (fail-soft)", async () => {
    const live = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    const dead: McpToolClient = {
      async connect() { throw new Error("unreachable"); },
      async listTools() { return []; },
      async callTool() { return ""; },
      async close() {},
    };
    const { be, events, started, itemsRef } = startWorker("w-dead", () =>
      connectRuntimeMcpTools({ dead: { command: "no" }, fake: { command: "x" } }, (name) => (name === "dead" ? dead : fakeMcpClient(live)), { warn() {} }));
    await started;
    await be.whenSettled("w-dead");

    // The dead server is gone; the live one is still offered + callable.
    assert.ok(!itemsRef().some((i) => i.name.startsWith("mcp__dead__")), "dead server dropped");
    assert.ok(itemsRef().some((i) => i.name === "mcp__fake__echo"), "live server survives");
    assert.deepEqual(live.calls, [{ name: "echo", args: { v: 42 } }]);
    // The session ran to completion despite the dead server.
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"));
  });
});
