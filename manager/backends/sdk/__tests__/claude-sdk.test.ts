import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper } from "../SdkEventMapper.ts";
import { createClaudeSdkBackend, type SdkQueryFn } from "../ClaudeSdkBackend.ts";
import type { AgentLaunchSpec } from "../../../../core/src/ports/AgentBackend.ts";
import type { ToolContext } from "../../../tools/types.ts";

// A scripted SDK message stream for one turn: init -> message_start -> thinking
// deltas (with a dropped signature_delta) -> a content_block_stop -> a text delta
// -> the durable assistant message -> result. No real model, no billing.
//
// Every stream_event carries a DISTINCT `uuid` (u-start, u1, u2, …) exactly as
// the real SDK does — a fresh UUID per partial. The stable blockId must come from
// the Anthropic message id (message_start.message.id == assistant.message.id ==
// "msg_A"), NOT from `uuid`. If the mapper ever regresses to keying on uuid, the
// per-delta blockIds scatter (each token its own block) and this test fails.
const SCRIPT: unknown[] = [
  { type: "system", subtype: "init", session_id: "sess-1" },
  { type: "stream_event", uuid: "u-start", event: { type: "message_start", message: { id: "msg_A" } } },
  { type: "stream_event", uuid: "u1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me " } } },
  { type: "stream_event", uuid: "u2", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } } },
  { type: "stream_event", uuid: "u3", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "xx" } } },
  { type: "stream_event", uuid: "u4", event: { type: "content_block_stop", index: 0 } },
  { type: "stream_event", uuid: "u5", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
  { type: "assistant", uuid: "u6", message: { id: "msg_A", content: [{ type: "thinking", thinking: "let me think" }, { type: "text", text: "answer" }] } },
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
      "delta:reasoning:start:msg_A:0",
      "delta:reasoning:append:msg_A:0",
      "delta:reasoning:stop:msg_A:0",
      "delta:text:start:msg_A:1",
      "delta:text:stop:msg_A:1",
      "msg:assistant:reasoning,text",
      "usage",
      "turn:ended",
    ]);
    assert.equal(mapper.sessionId, "sess-1");
    // Every delta of one block shares ONE blockId (anchored on the message id, not
    // the per-partial uuid) — so the UI accumulates into a single growing block.
    const startEvents = out.filter((e) => e.type === "delta" && e.phase === "start");
    assert.equal(startEvents.length, 2, "exactly one live block opened per content block (reasoning + text)");
    // Durable blocks carry the SAME blockId the live deltas used (UI handoff).
    const msg = out.find((e) => e.type === "message");
    assert.deepEqual(msg && msg.type === "message" ? msg.blocks.map((b) => (b as { blockId?: string }).blockId) : null, ["msg_A:0", "msg_A:1"]);
    const usage = out.find((e) => e.type === "usage");
    assert.deepEqual(usage && usage.type === "usage" ? usage.usage : null, {
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: {}, model: "claude-opus-4-8",
    });
  });

  // Two assistant messages in one turn (a tool call between them) both stream a
  // block at index 0. They MUST get distinct blockIds — keyed on the message id,
  // not the index alone — or the second message's live block would be suppressed
  // by the first's durable block (same id) and never render.
  it("distinct messages in one turn never share a blockId", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "stream_event", uuid: "a0", event: { type: "message_start", message: { id: "msg_A" } } },
      { type: "stream_event", uuid: "a1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "calling tool" } } },
      { type: "stream_event", uuid: "a2", event: { type: "content_block_stop", index: 0 } },
      { type: "assistant", uuid: "a3", message: { id: "msg_A", content: [{ type: "text", text: "calling tool" }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } },
      { type: "user", uuid: "u0", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      { type: "stream_event", uuid: "b0", event: { type: "message_start", message: { id: "msg_B" } } },
      { type: "stream_event", uuid: "b1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
      { type: "assistant", uuid: "b2", message: { id: "msg_B", content: [{ type: "text", text: "done" }] } },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    const startIds = out.filter((e) => e.type === "delta" && e.phase === "start").map((e) => (e as { blockId: string }).blockId);
    assert.deepEqual(startIds, ["msg_A:0", "msg_B:0"], "index-0 blocks of different messages get distinct ids");
    const durableIds = out.filter((e) => e.type === "message" && e.role === "assistant")
      .flatMap((e) => (e as { blocks: { blockId?: string }[] }).blocks.map((b) => b.blockId).filter(Boolean));
    assert.deepEqual(durableIds, ["msg_A:0", "msg_B:0"], "durable blocks match their live ids across messages");
  });

  // The SDK surfaces ONE assistant message (same message id) as SEPARATE
  // `assistant` SDKMessages — one per content block, each a length-1 content
  // array. The text block streams at content_block index 1 but arrives in a
  // length-1 durable array (array position 0). Deriving the durable index from
  // the array position stamps it ":0" — colliding with the thinking block AND
  // mismatching the live ":1" id, so the live text never hands off and the
  // answer renders twice. The durable index must be the GLOBAL position.
  it("split assistant messages (one block each) keep durable ids aligned with the stream", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "stream_event", uuid: "a0", event: { type: "message_start", message: { id: "msg_A" } } },
      { type: "stream_event", uuid: "a1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder" } } },
      { type: "stream_event", uuid: "a2", event: { type: "content_block_stop", index: 0 } },
      { type: "assistant", uuid: "a3", message: { id: "msg_A", content: [{ type: "thinking", thinking: "ponder" }] } },
      { type: "stream_event", uuid: "a4", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
      { type: "stream_event", uuid: "a5", event: { type: "content_block_stop", index: 1 } },
      { type: "assistant", uuid: "a6", message: { id: "msg_A", content: [{ type: "text", text: "answer" }] } },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    // Live ids the deltas used.
    const liveIds = out.filter((e) => e.type === "delta" && e.phase === "start").map((e) => (e as { blockId: string }).blockId);
    assert.deepEqual(liveIds, ["msg_A:0", "msg_A:1"]);
    // Durable ids MUST match the live ids — text is msg_A:1, not msg_A:0.
    const durableIds = out.filter((e) => e.type === "message" && e.role === "assistant")
      .flatMap((e) => (e as { blocks: { blockId?: string }[] }).blocks.map((b) => b.blockId).filter(Boolean));
    assert.deepEqual(durableIds, ["msg_A:0", "msg_A:1"], "split text block keeps its global index (no collision, hands off)");
  });

  // A subagent (Task/Agent tool) reports its internal messages with
  // parent_tool_use_id set. Those inner tools must surface as PARENTED activity
  // (grouped under the agentRun by the UI), NOT as top-level durable blocks in
  // the main stream — otherwise the subagent's tools leak into the parent's chat.
  it("attributes subagent inner tools (parent_tool_use_id) to the agent, not the main stream", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", uuid: "a0", message: { id: "msg_A", content: [{ type: "tool_use", id: "agent_1", name: "Agent", input: { description: "sub" } }] } },
      { type: "assistant", uuid: "a1", parent_tool_use_id: "agent_1", message: { id: "msg_sub", content: [{ type: "tool_use", id: "inner_1", name: "Bash", input: { command: "find ." } }] } },
      { type: "user", uuid: "u1", parent_tool_use_id: "agent_1", message: { content: [{ type: "tool_result", tool_use_id: "inner_1", content: "found", is_error: false }] } },
      { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "agent_1", content: "report", is_error: false }] } },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));

    // Only the top-level Agent tool is a durable tool_call block; the inner Bash is not.
    const toolCallNames = out
      .filter((e) => e.type === "message" && e.role === "assistant")
      .flatMap((e) => (e as { blocks: { type: string; name?: string }[] }).blocks)
      .filter((b) => b.type === "tool_call").map((b) => b.name);
    assert.deepEqual(toolCallNames, ["Agent"]);

    // The inner tool surfaces as parented activity carrying its input + result.
    const innerStart = out.find((e) => e.type === "activity" && e.kind === "tool_started" && (e as { callId?: string }).callId === "inner_1") as { parentCallId?: string; input?: Record<string, unknown> } | undefined;
    assert.equal(innerStart?.parentCallId, "agent_1");
    assert.deepEqual(innerStart?.input, { command: "find ." });
    const innerDone = out.find((e) => e.type === "activity" && e.kind === "tool_finished" && (e as { callId?: string }).callId === "inner_1") as { parentCallId?: string; result?: string } | undefined;
    assert.equal(innerDone?.parentCallId, "agent_1");
    assert.equal(innerDone?.result, "found");

    // The Agent tool's OWN result IS a durable tool message (the agentRun's result).
    const toolMsgs = out.filter((e) => e.type === "message" && e.role === "tool");
    assert.equal(toolMsgs.length, 1);
    assert.equal((toolMsgs[0] as { blocks: { callId?: string }[] }).blocks[0].callId, "agent_1");
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
    // tool-surface isolation + gating (Step A)
    assert.deepEqual(capturedOptions!.settingSources, []);
    assert.equal(capturedOptions!.strictMcpConfig, true);
    assert.deepEqual(capturedOptions!.disallowedTools, ["AskUserQuestion"]);
    assert.deepEqual(capturedOptions!.allowedTools, []); // nothing auto-approved → canUseTool gates every call
    assert.equal(capturedOptions!.systemPrompt, undefined); // no assembleAppendPrompt dep here → no append
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

  it("sends the assembled Eos system prompt as a claude_code preset append", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => {
      capturedOptions = params.options as unknown as Record<string, unknown>;
      return (async function* () { /* idle */ })();
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "oat01-x" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescription: (n) => n },
      daemonUrl: "http://127.0.0.1:7400",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      assembleAppendPrompt: () => "EOS ORCHESTRATION PROTOCOL",
      queryFn,
    });
    await be.start(spec(), {});
    assert.deepEqual(capturedOptions!.systemPrompt, { type: "preset", preset: "claude_code", append: "EOS ORCHESTRATION PROTOCOL" });
  });

  it("bypassPermissions sets the explicit allowDangerouslySkipPermissions safety flag", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => {
      capturedOptions = params.options as unknown as Record<string, unknown>;
      return (async function* () { /* idle */ })();
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescription: (n) => n },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    await be.start(spec({ permissionMode: "bypassPermissions" }), {});
    assert.equal(capturedOptions!.permissionMode, "bypassPermissions");
    assert.equal(capturedOptions!.allowDangerouslySkipPermissions, true);
  });
});
