import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper } from "../SdkEventMapper.ts";
import { createClaudeSdkBackend, type SdkQueryFn } from "../ClaudeSdkBackend.ts";
import type { AgentLaunchSpec } from "../../../../core/src/ports/AgentBackend.ts";
import type { ToolContext } from "../../../tools/types.ts";

// A scripted SDK message stream for one turn: init -> thinking deltas (with a
// dropped signature_delta) -> a content_block_stop -> a text delta -> the durable
// assistant message -> result. No real model, no billing.
const SCRIPT: unknown[] = [
  { type: "system", subtype: "init", session_id: "sess-1" },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } } },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } } },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "xx" } } },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_stop", index: 0 } },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
  { type: "assistant", uuid: "u1", message: { content: [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "answer" }] } },
  { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, model: "claude-opus-4-8" },
];

function tag(e: AgentEvent): string {
  switch (e.type) {
    case "delta": return `delta:${e.channel}:${e.phase}:${e.blockId}`;
    case "message": return `msg:${e.role}:${e.blocks.map((b) => b.type).join(",")}`;
    case "turn": return `turn:${e.phase}`;
    case "session": return `session:${e.phase}`;
    case "activity": return `act:${e.kind}`;
    default: return e.type;
  }
}

describe("SdkEventMapper — SDK stream -> canonical sequence", () => {
  it("synthesizes blockId, lazy-opens, drops non-live deltas, and orders the turn", () => {
    const mapper = createSdkEventMapper();
    const out: AgentEvent[] = [];
    for (const m of SCRIPT) out.push(...mapper.map(m as never));
    assert.deepEqual(out.map(tag), [
      "session:ready",
      "turn:started",
      "delta:reasoning:start:u1:0",
      "delta:reasoning:append:u1:0",
      "delta:reasoning:stop:u1:0",
      "delta:text:start:u1:1",
      "delta:text:stop:u1:1",
      "msg:assistant:reasoning,text",
      "usage",
      "turn:ended",
    ]);
    assert.equal(mapper.sessionId, "sess-1");
    // Durable blocks carry the SAME blockId the live deltas used (UI handoff).
    const msg = out.find((e) => e.type === "message");
    assert.deepEqual(msg && msg.type === "message" ? msg.blocks.map((b) => (b as { blockId?: string }).blockId) : null, ["u1:0", "u1:1"]);
    const usage = out.find((e) => e.type === "usage");
    assert.deepEqual(usage && usage.type === "usage" ? usage.usage : null, {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: {}, model: "claude-opus-4-8",
    });
  });
});

describe("ClaudeSdkBackend — FakeSdkQuery (no real model, no billing)", () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

  function spec(over: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
    return { workerId: "w-1", cwd: "/repo", model: "claude-opus-4-8", prompt: "go", persistent: true, parentId: null, isOrchestrator: false, ...over };
  }

  it("emits the canonical sequence, scrubs the key, injects OAuth + ENABLE_TOOL_SEARCH, and gates via canUseTool", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const events: AgentEvent[] = [];
    const ctxSelfIds: string[] = [];
    let capturedOptions: Record<string, unknown> | null = null;

    const queryFn: SdkQueryFn = (params) => {
      capturedOptions = params.options as unknown as Record<string, unknown>;
      return (async function* () { for (const m of SCRIPT) yield m; })();
    };
    const makeToolContext = (s: AgentLaunchSpec): ToolContext => {
      ctxSelfIds.push(s.workerId);
      return { selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) };
    };

    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "oat01-x" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescription: (n) => n },
      daemonUrl: "http://127.0.0.1:7400",
      makeToolContext,
      queryFn,
    });

    let exitCode: number | null = -1;
    const exited = new Promise<void>((res) => {
      be.start(spec(), { onEvent: (e) => events.push(e), onExit: (c) => { exitCode = c; res(); } });
    });
    await exited;

    assert.equal(exitCode, 0);
    assert.deepEqual(events.map(tag).slice(0, 3), ["session:started", "session:ready", "turn:started"]);
    assert.ok(events.some((e) => e.type === "message" && e.role === "assistant"));
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"));
    // billing guard reached the SDK options
    const env = capturedOptions!.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat01-x");
    assert.equal(env.ENABLE_TOOL_SEARCH, "false");
    assert.equal(capturedOptions!.includePartialMessages, true);
    assert.equal(typeof capturedOptions!.canUseTool, "function");
    assert.deepEqual(ctxSelfIds, ["w-1"]); // ctx identity bound per-spec, not process.env
  });

  it("per-spec tool context: concurrent workers never share identity", async () => {
    const seen: string[] = [];
    const queryFn: SdkQueryFn = () => (async function* () { /* idle session */ })();
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescription: (n) => n },
      daemonUrl: "http://x",
      makeToolContext: (s) => { seen.push(s.workerId); return { selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }; },
      queryFn,
    });
    await be.start(spec({ workerId: "a" }), {});
    await be.start(spec({ workerId: "b" }), {});
    assert.deepEqual(seen, ["a", "b"]);
  });
});
