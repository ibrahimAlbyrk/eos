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
import { createInProcessBackend, type InProcessEnv } from "../../infra/src/backends/InProcessBackend.ts";
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

  // External MCP connects in the BACKGROUND (instant start), so its tools land on a
  // SUBSEQUENT turn, never turn 1. The worker is spawned with NO boot prompt; once the
  // background connect has settled (env.whenMcpReady) we drive the MCP-calling turn
  // explicitly with sendMessage — mirroring how a real session's first user message
  // (or the orchestrator's first decomposition turn) arrives after setup.
  function startWorker(workerId: string, makeMcp: () => Promise<RuntimeMcpToolset>) {
    const events: AgentEvent[] = [];
    let offeredItems: { name: string }[] = [];
    let env: InProcessEnv | undefined;
    const factory = createInProcessEnvFactory({
      assembleSystem: () => null,
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: (id) => realGate(id),
      resolveMcpTools: () => makeMcp(),
      buildModelClient: ({ items }) => { offeredItems = items; return fakeModel(turns); },
    });
    const be = createInProcessBackend("fake-api", async (s) => { env = await factory(s); return env; });
    const started = be.start({ ...spec(workerId), prompt: "" }, { onEvent: (e) => events.push(e) });
    return { be, events, started, itemsRef: () => offeredItems, env: () => env! };
  }

  it("an API worker lists + calls a fake MCP tool, gated mcp-always-allow", async () => {
    const rec = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    const { be, events, started, itemsRef, env } = startWorker("w-mcp", () => connectRuntimeMcpTools({ fake: { command: "x" } }, () => fakeMcpClient(rec)));
    const session = await started;
    // Session is ready immediately (built-ins only); the external tool lands once the
    // background connect resolves — then a subsequent turn can call it.
    await env().whenMcpReady;
    await session.sendMessage("go");
    await be.whenSettled("w-mcp");

    // LIST: after the background connect, the model was offered the external tool.
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
    const { be, events, started, itemsRef, env } = startWorker("w-dead", () =>
      connectRuntimeMcpTools({ dead: { command: "no" }, fake: { command: "x" } }, (name) => (name === "dead" ? dead : fakeMcpClient(live)), { warn() {} }));
    const session = await started;
    await env().whenMcpReady;
    await session.sendMessage("go");
    await be.whenSettled("w-dead");

    // The dead server is gone; the live one is still offered + callable.
    assert.ok(!itemsRef().some((i) => i.name.startsWith("mcp__dead__")), "dead server dropped");
    assert.ok(itemsRef().some((i) => i.name === "mcp__fake__echo"), "live server survives");
    assert.deepEqual(live.calls, [{ name: "echo", args: { v: 42 } }]);
    // The session ran to completion despite the dead server.
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"));
  });
});

describe("API-lane MCP — instant start (background connect)", () => {
  // These tests probe the background-connect TIMING, not gate classification, so an
  // always-allow gate keeps the built-in/MCP calls focused on what's being asserted.
  const allowGate = { async decide() { return { allow: true }; } };
  // A built-in (lane) tool the model can call on turn 1 WITHOUT any external MCP.
  function pingTooling() {
    const calls: string[] = [];
    const tools = new Map<string, { name: string; execute: (i: Record<string, unknown>) => Promise<string> }>();
    tools.set("ping", { name: "ping", execute: async () => { calls.push("ping"); return "pong"; } });
    return { calls, build: () => ({ items: [{ name: "ping", description: "ping", schema: { type: "object", properties: {} } }], tools: new Map(tools) }) };
  }
  const pingThenEnd: ModelTurn[] = [
    { toolCalls: [{ callId: "p1", name: "ping", input: {} }], stopReason: "tool_use" },
    { text: "ok", toolCalls: [], stopReason: "end_turn" },
  ];

  // A SLOW/HANGING external connect must NOT block the env factory, session-ready, or
  // the spawn return — the boot turn still runs against built-ins. If it DID block, the
  // awaits below would never resolve and the test would time out (the failure signal).
  it("a hanging resolveMcpTools never blocks session start or the first built-in turn", async () => {
    const ping = pingTooling();
    const factory = createInProcessEnvFactory({
      assembleSystem: () => null,
      buildLaneTooling: () => ping.build(),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: () => allowGate,
      resolveMcpTools: () => new Promise<RuntimeMcpToolset>(() => {}), // never resolves
      buildModelClient: () => fakeModel(pingThenEnd),
    });
    const be = createInProcessBackend("fake-api", factory);
    const events: AgentEvent[] = [];
    // start() resolves promptly despite the hung connect (it is NOT awaited).
    const session = await be.start({ ...spec("w-hang"), prompt: "go" }, { onEvent: (e) => events.push(e) });
    await be.whenSettled("w-hang");

    assert.ok(session.isAlive(), "session is live with the connect still pending");
    assert.deepEqual(ping.calls, ["ping"], "the boot turn ran against built-ins, not blocked on MCP");
    assert.ok(events.some((e) => e.type === "session" && e.phase === "started"), "session started immediately");
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"), "the first turn completed");
  });

  // The model sees mcp__<server>__<tool> only AFTER the background connect resolves +
  // env.model is rebuilt — proving the snapshot-at-construction client was swapped.
  it("external MCP tools become available after the background connect resolves", async () => {
    const rec = { calls: [] as Array<{ name: string; args: Record<string, unknown> }>, closed: false };
    let offered: { name: string }[] = [];
    let env: InProcessEnv | undefined;
    const factory = createInProcessEnvFactory({
      assembleSystem: () => null,
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: () => allowGate,
      resolveMcpTools: () => connectRuntimeMcpTools({ fake: { command: "x" } }, () => fakeMcpClient(rec)),
      buildModelClient: ({ items }) => { offered = items; return fakeModel([{ toolCalls: [{ callId: "c1", name: "mcp__fake__echo", input: { v: 9 } }], stopReason: "tool_use" }, { text: "done", toolCalls: [], stopReason: "end_turn" }]); },
    });
    const be = createInProcessBackend("fake-api", async (s) => { env = await factory(s); return env; });
    const session = await be.start({ ...spec("w-after"), prompt: "" }, {});

    // After the background connect resolves, env.model was rebuilt over the full
    // surface, so the model is now offered the external tool (snapshot client swapped).
    await env!.whenMcpReady;
    assert.ok(offered.some((i) => i.name === "mcp__fake__echo"), "MCP offered after the rebuild");
    // A subsequent turn dispatches the now-available external tool.
    await session.sendMessage("go");
    await be.whenSettled("w-after");
    assert.deepEqual(rec.calls, [{ name: "echo", args: { v: 9 } }], "the external tool ran on a subsequent turn");
  });

  // stop() while the connect is still in flight must return immediately (no await on the
  // handshake); the late-resolving connect then tears itself down (no leaked client).
  it("closeSession tears down a still-pending external connect without hanging", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const rec = { closed: false };
    const toolset: RuntimeMcpToolset = { items: [], tools: new Map(), async close() { rec.closed = true; } };
    let env: InProcessEnv | undefined;
    const factory = createInProcessEnvFactory({
      assembleSystem: () => null,
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { apiKey: "" }; } },
      makeGate: () => allowGate,
      resolveMcpTools: async () => { await gate; return toolset; },
      buildModelClient: () => fakeModel([{ toolCalls: [], stopReason: "end_turn" }]),
    });
    const be = createInProcessBackend("fake-api", async (s) => { env = await factory(s); return env; });
    const session = await be.start({ ...spec("w-pending"), prompt: "" }, {});

    // The connect is still pending: stop() returns without blocking on it.
    session.stop();
    assert.equal(session.isAlive(), false, "stop returned without awaiting the pending connect");
    assert.equal(rec.closed, false, "nothing connected yet, so nothing closed yet");

    // When the connect finally lands, the background task observes `stopped` and closes
    // it — no leaked connection.
    release();
    await env!.whenMcpReady;
    assert.equal(rec.closed, true, "the late-resolving connect was torn down");
  });
});
