import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessBackend, type InProcessEnv } from "../backends/InProcessBackend.ts";
import { createAnthropicModelClient } from "../backends/AnthropicModelClient.ts";
import { JsonlConversationStore } from "../conversation/JsonlConversationStore.ts";
import { randomIdGenerator } from "../id/RandomIdGenerator.ts";
import type { ModelClient, ModelTurn, ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import type { RuntimeTool, ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent, AgentLaunchSpec } from "../../../core/src/ports/AgentBackend.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

const allowGate: ToolGate = { async decide() { return { allow: true }; } };

function spec(prompt: string): AgentLaunchSpec {
  return { workerId: "w1", cwd: "/tmp", model: "claude-x", prompt, persistent: false, parentId: null, isOrchestrator: false };
}

// A minimal Anthropic Messages Response stub (non-streaming, like reasoning-round-trip).
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };
function res(status: number, bodyObj: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: null,
    async json() { return bodyObj; },
    async text() { return JSON.stringify(bodyObj); },
  } as unknown as Response;
}

const ANTHROPIC: ProviderCapabilities = {
  wire: "anthropic", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true,
  reasoning: "none", reasoningRoundTrip: "preserve-signed", cache: "none", structuredOutput: "none", contextWindow: 200000,
};

// ─── B1: multi-turn must keep roles alternating (Anthropic 400s on user→user) ────

describe("B1 — in-process multi-turn keeps roles alternating (Anthropic dialect)", () => {
  it("persists the assistant text turn so a 2nd user message does not create two consecutive user roles", async () => {
    // STRICT Anthropic stub: 400 on two consecutive user-role messages, exactly like
    // the real Messages API. Before B1, turn 2 sends [user, user] → 400. After B1 the
    // assistant's reply sits between them, so it alternates.
    const sawRoles: string[][] = [];
    let consecutiveUserSeen = false;
    const fetchImpl = (async (_url: string, init: FetchInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string }> };
      const roles = body.messages.map((m) => m.role);
      sawRoles.push(roles);
      for (let i = 1; i < roles.length; i++) if (roles[i] === "user" && roles[i - 1] === "user") consecutiveUserSeen = true;
      if (consecutiveUserSeen) return res(400, { error: { message: "messages: roles must alternate" } });
      return res(200, { content: [{ type: "text", text: `ok-${roles.length}` }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } });
    }) as unknown as typeof fetch;

    const env: InProcessEnv = {
      model: createAnthropicModelClient({ apiKey: "k", model: "claude-x", capabilities: ANTHROPIC, fetchImpl }),
      tools: new Map<string, RuntimeTool>(),
      gate: allowGate,
    };
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("anthropic-api", () => env);
    const session = await be.start(spec("first task"), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");
    await session.sendMessage("second task");
    await be.whenSettled("w1");

    assert.equal(consecutiveUserSeen, false, "no two consecutive user-role messages reached the Anthropic client");
    assert.equal(events.some((e) => e.type === "turn" && e.phase === "error"), false, "no turn:error (no 400) on the 2nd turn");
    // The 2nd request carried the assistant's prior reply between the two user turns.
    assert.deepEqual(sawRoles[1], ["user", "assistant", "user"], "history alternates: user → assistant → user");
  });
});

// ─── MJ1: serialize turns + a /clear is not undone by an aborted turn's persist ──

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("MJ1 — in-process serializes turns + clear-during-turn is not undone", () => {
  it("serializes a concurrent dispatch: the 2nd message runs only after the 1st turn settles", async () => {
    const gate = deferred();
    const entered = deferred();
    const seen: unknown[][] = [];
    let calls = 0;
    const model: ModelClient = {
      async createTurn(messages: ModelMessage[]) {
        calls++;
        seen.push(messages.map((m) => m.content));
        if (calls === 1) { entered.resolve(); await gate.promise; }
        return { text: `r${calls}`, toolCalls: [], stopReason: "end_turn" } as ModelTurn;
      },
    };
    const env: InProcessEnv = { model, tools: new Map(), gate: allowGate };
    const be = createInProcessBackend("anthropic-api", () => env);
    const session = await be.start(spec("first"), {});
    await entered.promise; // turn 1 is in flight (blocked in the model)

    void session.sendMessage("second"); // dispatched WHILE turn 1 runs
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1, "the 2nd dispatch did not start a concurrent turn while the 1st was in flight");

    gate.resolve();
    await be.whenSettled("w1");
    assert.equal(calls, 2, "the 2nd turn ran after the 1st settled");
    assert.deepEqual(seen[1], ["first", "r1", "second"], "the 2nd turn saw the 1st turn's assistant reply (serialized, not lost)");
  });

  it("a /clear during an in-flight turn is not undone by the aborted turn's persist", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "eos-mj1-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new JsonlConversationStore(join(dir, "conversations"));
    let n = 0;
    const ids = { ...randomIdGenerator, newSessionId: () => `s-${++n}` };

    const gate = deferred();
    const entered = deferred();
    let calls = 0;
    const model: ModelClient = {
      async createTurn() {
        calls++;
        if (calls === 1) { entered.resolve(); await gate.promise; }
        return { text: "ack", toolCalls: [], stopReason: "end_turn" } as ModelTurn;
      },
    };
    const env: InProcessEnv = { model, tools: new Map(), gate: allowGate };
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("anthropic-api", () => env, { store, ids });
    const session = await be.start(spec("first task"), { onEvent: (e) => events.push(e) });
    await entered.promise; // turn 1 is in flight

    await session.clearContext!(); // aborts, clears the buffer, deletes the store, rolls to a fresh id, bumps generation
    const freshId = events
      .filter((e): e is Extract<AgentEvent, { type: "session"; phase: "ready" }> => e.type === "session" && e.phase === "ready")
      .map((e) => e.sessionId)
      .pop();
    gate.resolve(); // let the aborted turn 1 settle
    await be.whenSettled("w1");

    assert.ok(freshId, "clear rolled to a fresh session id");
    assert.equal(store.load(freshId!), null, "the aborted turn did not re-persist stale msgs under the fresh session id");
  });
});
