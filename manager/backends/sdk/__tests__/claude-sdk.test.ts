import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper } from "../SdkEventMapper.ts";
import { createClaudeSdkBackend, type SdkQueryFn } from "../ClaudeSdkBackend.ts";
import type { AgentLaunchSpec } from "../../../../core/src/ports/AgentBackend.ts";
import type { RewindTarget } from "../../../../core/src/domain/rewind-targets.ts";
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
    // The Agent tool_call carries the lane-neutral subagent marker so the UI folds it.
    const agentCall = out
      .filter((e) => e.type === "message" && e.role === "assistant")
      .flatMap((e) => (e as { blocks: { type: string; name?: string; spawnsSubagent?: boolean }[] }).blocks)
      .find((b) => b.type === "tool_call" && b.name === "Agent");
    assert.equal(agentCall?.spawnsSubagent, true);

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

  // A TOP-LEVEL tool surfaces FULLY as message blocks (tool_call + tool_result),
  // so per the canonical ActivityEvent contract the mapper emits NO activity for
  // it — one carrier per tool means the UI can never render the tool twice.
  // (Activities stay only for the block-less subagent inner tools — see above.)
  it("emits no activity for a top-level tool (the message blocks are the sole carrier)", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", uuid: "a0", message: { id: "msg_A", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }] } },
      { type: "user", uuid: "u0", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "data", is_error: false }] } },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    assert.equal(out.filter((e) => e.type === "activity").length, 0, "top-level tool emits no tool_started/tool_finished activity");
    // The tool still surfaces fully: exactly one tool_call block + one tool_result block, both keyed on t1.
    const callBlocks = out.filter((e) => e.type === "message" && e.role === "assistant")
      .flatMap((e) => (e as { blocks: { type: string; callId?: string }[] }).blocks).filter((b) => b.type === "tool_call");
    assert.deepEqual(callBlocks.map((b) => b.callId), ["t1"]);
    const resultMsgs = out.filter((e) => e.type === "message" && e.role === "tool");
    assert.equal(resultMsgs.length, 1);
    assert.equal((resultMsgs[0] as { blocks: { callId?: string }[] }).blocks[0].callId, "t1");
  });

  // Edit/Write's absolute-line-number patch rides the SDKUserMessage's
  // tool_use_result sidecar. When it carries a valid structuredPatch, the mapper
  // attaches it to the top-level tool_result block (same optional field both
  // lanes populate). The runtime shape is unverified, so garbage degrades to
  // no patch — never a throw.
  it("attaches patch from a tool_use_result sidecar carrying structuredPatch", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", uuid: "a0", message: { id: "msg_A", content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/x" } }] } },
      {
        type: "user", uuid: "u0",
        message: { content: [{ type: "tool_result", tool_use_id: "e1", content: "ok", is_error: false }] },
        tool_use_result: { structuredPatch: [{ oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, lines: ["-old", "+new"] }] },
      },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    const resultMsg = out.find((e) => e.type === "message" && e.role === "tool") as
      | { blocks: { patch?: { oldStart: number; newStart: number; lines: string[] }[] }[] } | undefined;
    assert.deepEqual(resultMsg?.blocks[0].patch, [{ oldStart: 42, newStart: 42, lines: ["-old", "+new"] }]);
  });

  it("degrades to no patch on a garbage / absent tool_use_result sidecar", () => {
    const run = (sidecar: unknown): AgentEvent[] => {
      const mapper = createSdkEventMapper();
      const script: unknown[] = [
        { type: "system", subtype: "init", session_id: "s" },
        { type: "assistant", uuid: "a0", message: { id: "msg_A", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
        { type: "user", uuid: "u0", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] }, ...(sidecar !== undefined ? { tool_use_result: sidecar } : {}) },
        { type: "result", subtype: "success", usage: {}, model: "m" },
      ];
      const out: AgentEvent[] = [];
      for (const m of script) out.push(...mapper.map(m as never));
      return out;
    };
    for (const sidecar of [undefined, {}, { structuredPatch: "nope" }, { structuredPatch: [{ foo: 1 }] }, "weird"]) {
      const out = run(sidecar);
      const resultMsg = out.find((e) => e.type === "message" && e.role === "tool") as { blocks: Record<string, unknown>[] } | undefined;
      assert.ok(resultMsg, "tool_result block still emitted");
      assert.equal(Object.prototype.hasOwnProperty.call(resultMsg!.blocks[0], "patch"), false, "no patch attached for garbage sidecar");
    }
  });

  // A result subtype of error_* is a failed turn — surfaced as turn:error (with the
  // subtype as the reason), not a clean turn:ended the worker would idle on as success.
  it("surfaces a result error subtype as turn:error, not turn:ended", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", uuid: "a", message: { id: "msg_A", content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "error_max_turns", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    const ends = out.filter((e) => e.type === "turn" && e.phase !== "started");
    assert.equal(ends.length, 1);
    assert.equal((ends[0] as { phase: string }).phase, "error");
    assert.equal((ends[0] as { reason?: string }).reason, "error_max_turns");
  });

  // Cache-creation tokens split by TTL tier: prefer the SDK's per-tier breakdown
  // (5m + 1h are priced differently), fall back to the flat total as 5m.
  it("maps the cache-creation TTL breakdown (5m + 1h), falling back to flat as 5m", () => {
    const withBreakdown = createSdkEventMapper();
    const a = withBreakdown.map({ type: "result", subtype: "success", usage: { cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 7 } }, model: "m" } as never);
    const ua = a.find((e) => e.type === "usage");
    assert.deepEqual(ua && ua.type === "usage" ? ua.usage.cacheWriteTokens : null, { "5m": 3, "1h": 7 });

    const flat = createSdkEventMapper();
    const b = flat.map({ type: "result", subtype: "success", usage: { cache_creation_input_tokens: 4 }, model: "m" } as never);
    const ub = b.find((e) => e.type === "usage");
    assert.deepEqual(ub && ub.type === "usage" ? ub.usage.cacheWriteTokens : null, { "5m": 4 });
  });

  // Context-window occupancy must come from each assistant message's OWN request
  // usage (the live footprint), NOT the turn-aggregate result.usage (which sums
  // every round-trip's tokens, incl. repeated cache reads → balloons past 1M).
  // `usage` stays the billing aggregate; `context` is the per-request snapshot.
  it("emits per-message context occupancy from assistant usage; result.usage stays billing-only", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      // round 1: small prompt (in + cacheRead + cacheCreate = 150)
      { type: "assistant", uuid: "a0", message: { id: "msg_A", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }], usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } },
      { type: "user", uuid: "u0", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      // round 2: history grew (500 + 400 = 900) — THIS is the occupancy at turn end
      { type: "assistant", uuid: "a1", message: { id: "msg_B", content: [{ type: "text", text: "done" }], usage: { input_tokens: 500, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 } } },
      // turn aggregate: input summed across both requests (wrong for the ring)
      { type: "result", subtype: "success", usage: { input_tokens: 600, cache_read_input_tokens: 420, cache_creation_input_tokens: 30 }, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));

    const contexts = out.filter((e) => e.type === "context").map((e) => (e as { tokens: number }).tokens);
    assert.deepEqual(contexts, [150, 900], "one occupancy snapshot per assistant message (latest = live footprint)");
    const usages = out.filter((e) => e.type === "usage");
    assert.equal(usages.length, 1, "billing usage emitted once, on result");
    assert.equal((usages[0] as { usage: { inputTokens: number } }).usage.inputTokens, 600, "result.usage stays the turn aggregate");
  });

  // A subagent's internal assistant message (parent_tool_use_id) has its OWN usage,
  // but that is a SEPARATE context window — it must never stamp the parent's ring.
  it("never emits context for subagent (parent_tool_use_id) assistant messages", () => {
    const mapper = createSdkEventMapper();
    const script: unknown[] = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", uuid: "a0", parent_tool_use_id: "agent_1", message: { id: "msg_sub", content: [{ type: "tool_use", id: "inner", name: "Bash", input: {} }], usage: { input_tokens: 9999, cache_read_input_tokens: 9999 } } },
      { type: "result", subtype: "success", usage: {}, model: "m" },
    ];
    const out: AgentEvent[] = [];
    for (const m of script) out.push(...mapper.map(m as never));
    assert.equal(out.filter((e) => e.type === "context").length, 0);
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
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
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
    assert.deepEqual(capturedOptions!.settingSources, ["user", "project"]); // load user/project so the binary discovers skills/agents/CLAUDE.md natively
    assert.deepEqual(capturedOptions!.managedSettings, { allowManagedPermissionRulesOnly: true }); // settings permission rules can't pre-approve ahead of the Eos gateway
    assert.equal(capturedOptions!.strictMcpConfig, true);
    assert.deepEqual(capturedOptions!.disallowedTools, ["AskUserQuestion", "Workflow"]); // worker spec (isOrchestrator:false) → blocked builtins only, Task kept
    assert.deepEqual(capturedOptions!.allowedTools, []); // nothing auto-approved → canUseTool gates every call
    assert.equal(capturedOptions!.systemPrompt, undefined); // no assembleAppendPrompt dep here → no append
    assert.deepEqual(ctxSelfIds, ["w-1"]); // ctx identity bound per-spec, not process.env
  });

  it("disallowedTools: orchestrator additionally drops Task; worker keeps it", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => {
      capturedOptions = params.options as unknown as Record<string, unknown>;
      return (async function* () { /* idle session */ })();
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s: AgentLaunchSpec): ToolContext => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });

    await be.start(spec({ isOrchestrator: true }), {});
    assert.deepEqual(capturedOptions!.disallowedTools, ["AskUserQuestion", "Workflow", "Task"]);

    capturedOptions = null;
    await be.start(spec({ isOrchestrator: false }), {});
    assert.deepEqual(capturedOptions!.disallowedTools, ["AskUserQuestion", "Workflow"]);
  });

  it("per-spec tool context: concurrent workers never share identity", async () => {
    const seen: string[] = [];
    const queryFn: SdkQueryFn = () => (async function* () { /* idle session */ })();
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
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
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
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
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    await be.start(spec({ permissionMode: "bypassPermissions" }), {});
    assert.equal(capturedOptions!.permissionMode, "bypassPermissions");
    assert.equal(capturedOptions!.allowDangerouslySkipPermissions, true);
  });

  it("runs the SDK session in the worker's cwd (not the daemon's)", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => { capturedOptions = params.options as unknown as Record<string, unknown>; return (async function* () { /* idle */ })(); };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    await be.start(spec({ cwd: "/work/tree" }), {});
    assert.equal(capturedOptions!.cwd, "/work/tree");
  });

  it("threads a resume session id into the SDK query options (daemon-restart revival)", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => { capturedOptions = params.options as unknown as Record<string, unknown>; return (async function* () { /* idle */ })(); };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    await be.start(spec({ backendOptions: { resume: "sess-prev" } }), {});
    assert.equal(capturedOptions!.resume, "sess-prev");
  });

  it("an interrupt that ends the stream exits as an interrupt (143 + turn:aborted), not a clean 0", async () => {
    // A controllable async iterable (not a generator) whose next() blocks until the
    // test resolves it — so we can interrupt() while the consume loop is mid-read,
    // then end the stream and assert the interrupt-aware exit path.
    let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null;
    const q = {
      interrupt: async () => {},
      [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>((res) => { resolveNext = res; }) }; },
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: () => q as never,
    });
    const events: AgentEvent[] = [];
    let exitCode: number | null = -1;
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((r) => { resolveExit = r; });
    const session = await be.start(spec(), { onEvent: (e) => events.push(e), onExit: (c) => { exitCode = c; resolveExit(); } });
    while (!resolveNext) await new Promise((r) => setTimeout(r, 1)); // wait for the loop to start reading
    await session.interrupt();                          // interrupting = true
    resolveNext({ done: true, value: undefined });      // stream ends mid-interrupt
    await exited;
    assert.equal(exitCode, 143);
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "aborted"));
  });

  // The SDK has no dedicated "interrupted" result subtype — a user-requested
  // interrupt ends the turn with subtype "error_during_execution", identical to
  // a genuine execution failure. The consume loop must translate that to
  // turn:aborted ONLY when WE set interrupting (session.interrupt() was called
  // for THIS turn); the same subtype arriving with no interrupt in flight is a
  // real failure and must keep surfacing as turn:error. A controllable async
  // iterable lets the test push messages on demand (mirrors the push-stream
  // helper the backend itself uses internally).
  function controllableStream() {
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    return {
      push(item: unknown) { queue.push(item); wake?.(); wake = null; },
      end() { closed = true; wake?.(); wake = null; },
      interrupt: async () => {},
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            while (!queue.length && !closed) await new Promise<void>((r) => { wake = r; });
            if (queue.length) return { done: false, value: queue.shift() };
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  it("with interrupting set, an error_during_execution result surfaces as turn:aborted (reason interrupted), not turn:error", async () => {
    const q = controllableStream();
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: () => q as never,
    });
    const events: AgentEvent[] = [];
    const session = await be.start(spec(), { onEvent: (e) => events.push(e) });
    q.push({ type: "system", subtype: "init", session_id: "sess-1" });
    while (!events.some((e) => e.type === "session" && e.phase === "ready")) await new Promise((r) => setTimeout(r, 1));

    await session.interrupt(); // sets interrupting = true

    q.push({ type: "result", subtype: "error_during_execution", usage: {}, model: "m" });
    while (!events.some((e) => e.type === "turn" && e.phase !== "started")) await new Promise((r) => setTimeout(r, 1));

    const ends = events.filter((e) => e.type === "turn" && e.phase !== "started");
    assert.equal(ends.length, 1);
    assert.equal((ends[0] as { phase: string }).phase, "aborted");
    assert.equal((ends[0] as { reason?: string }).reason, "interrupted");
    session.stop();
  });

  it("without interrupting, an error_during_execution result still surfaces as turn:error", async () => {
    const q = controllableStream();
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: () => q as never,
    });
    const events: AgentEvent[] = [];
    const session = await be.start(spec(), { onEvent: (e) => events.push(e) });
    q.push({ type: "system", subtype: "init", session_id: "sess-1" });
    while (!events.some((e) => e.type === "session" && e.phase === "ready")) await new Promise((r) => setTimeout(r, 1));

    q.push({ type: "result", subtype: "error_during_execution", usage: {}, model: "m" });
    while (!events.some((e) => e.type === "turn" && e.phase !== "started")) await new Promise((r) => setTimeout(r, 1));

    const ends = events.filter((e) => e.type === "turn" && e.phase !== "started");
    assert.equal(ends.length, 1);
    assert.equal((ends[0] as { phase: string }).phase, "error");
    assert.equal((ends[0] as { reason?: string }).reason, "error_during_execution");
    session.stop();
  });

  // Deleting/stopping an SDK agent must end its IN-FLIGHT turn, not just close
  // future input — a ghost turn keeps calling tools (and spawning workers) until
  // it ends on its own. stop() aborts the launch's AbortController (handed to
  // query() via Options.abortController) and best-effort interrupts the query.
  it("stop() aborts the in-flight query via the launch's AbortController + best-effort interrupt", async () => {
    let interrupted = false;
    let capturedOptions: Record<string, unknown> | null = null;
    const q = {
      interrupt: async () => { interrupted = true; },
      // an in-flight turn: the stream never yields (a long-running tool call)
      [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }; },
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: (params) => { capturedOptions = params.options as unknown as Record<string, unknown>; return q as never; },
    });
    let exitCode: number | null = -1;
    const session = await be.start(spec(), { onExit: (c) => { exitCode = c; } });
    const controller = capturedOptions!.abortController as AbortController;
    assert.ok(controller instanceof AbortController, "each launch hands query() its own AbortController");
    assert.equal(controller.signal.aborted, false);
    session.stop();
    assert.equal(controller.signal.aborted, true, "stop() aborts the in-flight turn");
    assert.equal(interrupted, true, "stop() also best-effort interrupts the live query");
    assert.equal(exitCode, 143);
    assert.equal(session.isAlive(), false);
  });

  // Recall (Layer 2): recallLastUserTurn forks the transcript sliced to the last
  // assistant uuid (the anchor) and RELAUNCHES the query resuming that forked
  // session — so the recalled, unanswered user message is in neither the agent's
  // context nor any future resume. Reuses the controllable-iterator pattern to
  // keep the session alive after the anchor message lands.
  it("recallLastUserTurn forks at the last assistant uuid and resumes the sliced session", async () => {
    // init + one completed assistant message set sessionId + lastAssistantUuid;
    // the stream then blocks so the session stays alive for the recall.
    const items: unknown[] = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "assistant", uuid: "asst-1", message: { id: "msg_A", content: [{ type: "text", text: "hi" }] } },
    ];
    let i = 0;
    let blockedReached = false; // true once the loop has consumed + mapped both items
    const q1 = {
      interrupt: async () => {},
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (i < items.length) return Promise.resolve({ done: false, value: items[i++] });
            blockedReached = true;
            return new Promise<IteratorResult<unknown>>(() => {}); // block forever
          },
        };
      },
    };
    const q2 = (async function* () { /* resumed sliced session — idle */ })();
    const launched: Array<Record<string, unknown>> = [];
    const queries: unknown[] = [q1, q2];
    let qi = 0;
    const queryFn: SdkQueryFn = (params) => { launched.push(params.options as unknown as Record<string, unknown>); return queries[qi++] as never; };
    const forkCalls: Array<{ sessionId: string; options: { dir?: string; upToMessageId?: string } }> = [];
    const forkSessionFn = async (sessionId: string, options: { dir?: string; upToMessageId?: string }) => {
      forkCalls.push({ sessionId, options });
      return { sessionId: "sess-forked" };
    };

    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
      forkSessionFn,
    });

    const session = await be.start(spec({ cwd: "/repo" }), {});
    while (!blockedReached) await new Promise((r) => setTimeout(r, 1)); // both items mapped → anchor set
    const r = await session.recallLastUserTurn!();

    assert.deepEqual(r, { ok: true });
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].sessionId, "sess-1");
    assert.equal(forkCalls[0].options.upToMessageId, "asst-1");
    assert.equal(forkCalls[0].options.dir, "/repo"); // scoped to the worker's project dir
    assert.equal(launched.length, 2, "a second query is launched (the recall relaunch)");
    assert.equal(launched[1].resume, "sess-forked", "relaunch resumes the sliced (forked) session");
    // Regression: the relaunch must build FRESH MCP server instances. An McpServer
    // allows one transport per instance — reusing the first query's makes the new
    // connect throw "Already connected" (silently swallowed by the SDK), and the
    // agent loses every Eos tool exactly when an interrupt recalled its message.
    assert.notEqual(
      (launched[0].mcpServers as Record<string, unknown>).worker,
      (launched[1].mcpServers as Record<string, unknown>).worker,
      "recall relaunch reuses the first query's MCP server instance",
    );
  });

  // No prior assistant message (the recalled message was the first turn) → nothing
  // precedes it, so recall relaunches FRESH (no fork, no resume) like /clear.
  it("recallLastUserTurn with no anchor relaunches fresh (first-turn recall)", async () => {
    const items: unknown[] = [{ type: "system", subtype: "init", session_id: "sess-1" }];
    let i = 0;
    let blockedReached = false;
    const q1 = {
      interrupt: async () => {},
      [Symbol.asyncIterator]() {
        return { next: () => (i < items.length ? Promise.resolve({ done: false, value: items[i++] }) : (blockedReached = true, new Promise<IteratorResult<unknown>>(() => {}))) };
      },
    };
    const q2 = (async function* () { /* fresh session — idle */ })();
    const launched: Array<Record<string, unknown>> = [];
    const queries: unknown[] = [q1, q2];
    let qi = 0;
    const queryFn: SdkQueryFn = (params) => { launched.push(params.options as unknown as Record<string, unknown>); return queries[qi++] as never; };
    let forked = false;
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
      forkSessionFn: async () => { forked = true; return { sessionId: "x" }; },
    });
    const session = await be.start(spec(), {});
    while (!blockedReached) await new Promise((r) => setTimeout(r, 1));
    const r = await session.recallLastUserTurn!();
    assert.deepEqual(r, { ok: true });
    assert.equal(forked, false, "no fork without an anchor");
    assert.equal(launched.length, 2);
    assert.equal(launched[1].resume, undefined, "fresh relaunch — no resume");
  });

  // Rewind (the double-Esc panel / per-message undo). A scripted active-branch
  // transcript: u1 -> a1 -> u2 -> a2. getRewindTargets lists u1,u2; rewind rolls
  // the conversation back to BEFORE a selected prompt. readTranscriptFn is a seam
  // so these assert the fork slice without touching ~/.claude on disk.
  const REWIND_TRANSCRIPT = [
    { type: "user", uuid: "u1", parentUuid: null, isSidechain: false, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "first prompt" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "r1" }] } },
    { type: "user", uuid: "u2", parentUuid: "a1", isSidechain: false, timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "second prompt" } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "r2" }] } },
  ].map((e) => JSON.stringify(e)).join("\n");

  // A session that captures its sessionId (system init) then blocks so it stays
  // alive for the rewind call. Returns { session, queryFn's launched, forkCalls,
  // ready }. Mirrors the recall tests' controllable-iterator pattern.
  function startRewindSession(over: {
    readTranscriptFn?: (cwd: string, sessionId: string) => string | null;
    forkSessionFn?: (sessionId: string, options: { dir?: string; upToMessageId?: string }) => Promise<{ sessionId: string }>;
  } = {}) {
    const items: unknown[] = [{ type: "system", subtype: "init", session_id: "sess-1" }];
    let i = 0;
    const ready = { hit: false };
    const q1 = {
      interrupt: async () => {},
      [Symbol.asyncIterator]() {
        return { next: () => (i < items.length ? Promise.resolve({ done: false, value: items[i++] }) : (ready.hit = true, new Promise<IteratorResult<unknown>>(() => {}))) };
      },
    };
    const q2 = (async function* () { /* resumed / fresh session — idle */ })();
    const queries: unknown[] = [q1, q2];
    let qi = 0;
    const launched: Array<Record<string, unknown>> = [];
    const queryFn: SdkQueryFn = (params) => { launched.push(params.options as unknown as Record<string, unknown>); return queries[qi++] as never; };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
      readTranscriptFn: over.readTranscriptFn ?? (() => REWIND_TRANSCRIPT),
      ...(over.forkSessionFn ? { forkSessionFn: over.forkSessionFn } : {}),
    });
    return { be, launched, ready };
  }

  it("getRewindTargets lists the active-branch user prompts from the transcript store", async () => {
    const seen: Array<{ cwd: string; sessionId: string }> = [];
    const { be, ready } = startRewindSession({ readTranscriptFn: (cwd, sessionId) => { seen.push({ cwd, sessionId }); return REWIND_TRANSCRIPT; } });
    const session = await be.start(spec({ cwd: "/repo" }), {});
    assert.equal(session.capabilities.rewind, true); // route + panel gate on this
    while (!ready.hit) await new Promise((r) => setTimeout(r, 1)); // sessionId captured
    const { targets } = await session.getRewindTargets!();
    assert.deepEqual(seen, [{ cwd: "/repo", sessionId: "sess-1" }]); // resolved from cwd + captured sessionId
    assert.deepEqual(targets.map((t) => (t as RewindTarget).uuid), ["u1", "u2"]);
    assert.deepEqual(targets.map((t) => (t as RewindTarget).upCount), [2, 1]);
    assert.deepEqual(targets.map((t) => (t as RewindTarget).display), ["first prompt", "second prompt"]);
    session.stop();
  });

  // PARITY PIN: the CLI "Restore conversation" restores to the point BEFORE the
  // selected user prompt (the submenu literally says "before you sent this
  // message"), and forkSession's upToMessageId is INCLUSIVE. So the SDK must slice
  // to the entry immediately before u2 — its parent a1 — NOT u2 itself (which
  // would keep the prompt in the forked session, i.e. restore-to-AFTER). This test
  // fails if the slice point ever regresses to the target uuid.
  it("rewind slices BEFORE the selected prompt (upToMessageId = its parent, not the prompt) and resumes the fork", async () => {
    const forkCalls: Array<{ sessionId: string; options: { dir?: string; upToMessageId?: string } }> = [];
    const { be, launched, ready } = startRewindSession({
      forkSessionFn: async (sessionId, options) => { forkCalls.push({ sessionId, options }); return { sessionId: "sess-forked" }; },
    });
    const session = await be.start(spec({ cwd: "/repo" }), {});
    while (!ready.hit) await new Promise((r) => setTimeout(r, 1));
    const r = await session.rewind!("u2", "conversation");
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].sessionId, "sess-1");
    assert.equal(forkCalls[0].options.upToMessageId, "a1", "slice to the parent of u2 (before it), never u2 itself");
    assert.equal(forkCalls[0].options.dir, "/repo"); // scoped to the worker's project dir
    assert.equal(launched.length, 2, "the conversation relaunch resumes the sliced session");
    assert.equal(launched[1].resume, "sess-forked");
    assert.deepEqual(r, { ok: true, uuid: "u2", text: "second prompt", display: "second prompt", index: 1 });
  });

  // Edge of the same parity rule: rewinding to the FIRST prompt has no predecessor
  // to slice to (parent is null) → relaunch fresh, no fork (like /clear + recall's
  // no-anchor branch).
  it("rewind to the first prompt relaunches fresh — nothing precedes it, so no fork", async () => {
    let forked = false;
    const { be, launched, ready } = startRewindSession({ forkSessionFn: async () => { forked = true; return { sessionId: "x" }; } });
    const session = await be.start(spec({ cwd: "/repo" }), {});
    while (!ready.hit) await new Promise((r) => setTimeout(r, 1));
    const r = await session.rewind!("u1", "conversation");
    assert.equal(forked, false, "no fork without a predecessor");
    assert.equal(launched.length, 2);
    assert.equal(launched[1].resume, undefined, "fresh relaunch — no resume");
    assert.deepEqual(r, { ok: true, uuid: "u1", text: "first prompt", display: "first prompt", index: 0 });
  });

  // Runtime model switch routes through the live SDK query's setModel control
  // method (streaming-input). effort is not an SDK lever — it's dropped here and
  // persisted by SetWorkerModel for the next resume. Mirrors the interrupt test's
  // controllable-iterator pattern to keep the session alive mid-read.
  it("setModel forwards to the live SDK query handle (runtime model switch)", async () => {
    const switched: Array<string | undefined> = [];
    let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null;
    const q = {
      setModel: async (m?: string) => { switched.push(m); },
      [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>((res) => { resolveNext = res; }) }; },
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: () => q as never,
    });
    let exitCode: number | null = -1;
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((r) => { resolveExit = r; });
    const session = await be.start(spec(), { onExit: (c) => { exitCode = c; resolveExit(); } });
    assert.equal(session.capabilities.runtimeModelSwitch, true);
    assert.deepEqual(await session.setModel("claude-sonnet-4-6", "high"), { ok: true });
    assert.deepEqual(switched, ["claude-sonnet-4-6"]); // model switched; effort dropped (no SDK lever)
    while (!resolveNext) await new Promise((r) => setTimeout(r, 1)); // let the consume loop start reading
    resolveNext({ done: true, value: undefined });                  // end the idle stream cleanly
    await exited;
    assert.equal(exitCode, 0);
  });

  // A switch on a dead/torn-down session degrades gracefully — no throw, ok:false.
  it("setModel returns ok:false when the session is gone", async () => {
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn: () => (async function* () { /* idle */ })() as never,
    });
    const session = await be.start(spec(), {});
    session.stop(); // tear down deterministically before the switch
    const r = await session.setModel("claude-opus-4-8");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "session gone");
  });

  // Inherited/external MCP servers reach query().mcpServers MERGED with the Eos
  // builtin; strictMcpConfig:true keeps MCP isolated to that explicit complete set
  // (never re-enabling native MCP discovery), independent of settingSources.
  it("merges resolved inherited MCP servers into options.mcpServers alongside the Eos builtin", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    let resolverArgs: { builtinKeys: string[] } | null = null;
    const queryFn: SdkQueryFn = (params) => {
      capturedOptions = params.options as unknown as Record<string, unknown>;
      return (async function* () { /* idle */ })();
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      resolveSdkMcpServers: (_spec, builtins) => {
        resolverArgs = { builtinKeys: Object.keys(builtins) };
        return { mcpServers: { ...builtins, context7: { type: "stdio", command: "c7" } } as never, dropped: [] };
      },
      queryFn,
    });
    await be.start(spec(), {});
    // The resolver is handed the Eos in-process builtin (server name "worker").
    assert.deepEqual(resolverArgs!.builtinKeys, ["worker"]);
    const servers = capturedOptions!.mcpServers as Record<string, unknown>;
    assert.deepEqual(Object.keys(servers).sort(), ["context7", "worker"]); // builtin + external
    assert.equal(capturedOptions!.strictMcpConfig, true);
    assert.deepEqual(capturedOptions!.settingSources, ["user", "project"]);
    assert.equal(typeof capturedOptions!.canUseTool, "function");
  });

  // DIP / judge isolation: WITHOUT the resolver dep the session sees ONLY its
  // builtins — no inherited servers leak into the appendless judge backend.
  it("without resolveSdkMcpServers, options.mcpServers holds only the builtin (judge isolation)", async () => {
    let capturedOptions: Record<string, unknown> | null = null;
    const queryFn: SdkQueryFn = (params) => { capturedOptions = params.options as unknown as Record<string, unknown>; return (async function* () { /* idle */ })(); };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    await be.start(spec(), {});
    assert.deepEqual(Object.keys(capturedOptions!.mcpServers as Record<string, unknown>), ["worker"]);
  });

  // Edge #8 (translator half): a dropped entry is logged and the session still starts.
  it("logs dropped inherited servers via log.warn and still starts the session", async () => {
    const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const queryFn: SdkQueryFn = () => (async function* () { /* idle */ })();
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "none" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      resolveSdkMcpServers: (_spec, builtins) => ({ mcpServers: builtins, dropped: [{ name: "bad", reason: "unsupported MCP server shape" }] }),
      log: { warn: (msg, meta) => warnings.push({ msg, meta }) },
      queryFn,
    });
    const session = await be.start(spec(), {});
    assert.ok(session); // start() resolved without throwing despite the dropped entry
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, "dropped inherited MCP servers");
    assert.deepEqual(warnings[0].meta?.dropped, [{ name: "bad", reason: "unsupported MCP server shape" }]);
  });

  // /clear on the SDK lane: the conversation lives in the SDK subprocess, so a
  // reset means restarting the query with a FRESH session (no resume). The old
  // query is interrupted and its consume loop, now superseded, must NOT report an
  // exit — the new query owns the session row.
  it("clearContext restarts the query without resume, keeps the session alive, and silences the old stream", async () => {
    const optionsSeen: Array<Record<string, unknown>> = [];
    const controllers: Array<{ end: () => void; interrupted: boolean; reading: boolean }> = [];
    const queryFn: SdkQueryFn = (params) => {
      optionsSeen.push(params.options as unknown as Record<string, unknown>);
      let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null;
      const ctrl = {
        interrupted: false,
        end: () => { resolveNext?.({ done: true, value: undefined }); resolveNext = null; },
        interrupt: async () => { ctrl.interrupted = true; ctrl.end(); },
        get reading() { return resolveNext !== null; },
        [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>((res) => { resolveNext = res; }) }; },
      };
      controllers.push(ctrl);
      return ctrl as never;
    };
    const be = createClaudeSdkBackend({
      authResolver: { resolve: async () => ({ scheme: "oauth", token: "t" }) },
      policy: { decide: async () => ({ behavior: "allow" }) },
      toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
      daemonUrl: "http://x",
      makeToolContext: (s) => ({ selfId: s.workerId, cwd: s.cwd, isGitRepo: () => false, api: async () => ({}) }),
      queryFn,
    });
    let exitCode: number | null = -1;
    const session = await be.start(spec({ backendOptions: { resume: "sess-old" } }), { onExit: (c) => { exitCode = c; } });
    assert.equal(session.capabilities.contextClear, true);
    assert.equal(optionsSeen[0].resume, "sess-old"); // initial launch honored resume
    while (!controllers[0].reading) await new Promise((r) => setTimeout(r, 1));

    await session.clearContext!();
    await new Promise((r) => setTimeout(r, 5)); // give any (erroneous) onExit time to fire

    assert.equal(optionsSeen.length, 2, "a second query was launched");
    assert.equal(optionsSeen[1].resume, undefined, "the restart never resumes — fresh session");
    // Same reconnect-safety contract as the recall relaunch: fresh MCP instances.
    assert.notEqual(
      (optionsSeen[0].mcpServers as Record<string, unknown>).worker,
      (optionsSeen[1].mcpServers as Record<string, unknown>).worker,
      "clear restart reuses the first query's MCP server instance",
    );
    assert.notEqual(optionsSeen[0].abortController, optionsSeen[1].abortController,
      "relaunch gets a FRESH AbortController — an aborted one must never be reused");
    assert.equal(controllers[0].interrupted, true, "old query interrupted during the swap");
    assert.equal(exitCode, -1, "the superseded old stream reports NO exit");
    assert.equal(session.isAlive(), true, "session stays alive across the restart");

    // The NEW query is now the live one — ending IT exits the session cleanly.
    while (!controllers[1].reading) await new Promise((r) => setTimeout(r, 1));
    controllers[1].end();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(exitCode, 0);
  });
});
