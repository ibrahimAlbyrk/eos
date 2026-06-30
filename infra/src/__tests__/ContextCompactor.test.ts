import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DropOldestContextCompactor } from "../conversation/DropOldestContextCompactor.ts";
import { runTurn, estimateTokens, type ToolGate, type RuntimeTool } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { ModelMessage, ModelClient } from "../../../core/src/ports/ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

// MJ4 / D8 — drop-oldest compaction near contextWindow, at whole tool-turn /
// MATCHED-PAIR granularity. The binding assertion: NO orphaned tool_use without its
// tool_result (or vice-versa) survives a pass (itself a 400 on Anthropic).

const compactor = new DropOldestContextCompactor();
const MARKER = "truncated to fit the model's context window";

function caps(window: number): ProviderCapabilities {
  return { wire: "anthropic", supportsStreaming: false, supportsTools: true, supportsParallelToolCalls: true, reasoning: "none", reasoningRoundTrip: "drop", cache: "none", structuredOutput: "none", contextWindow: window };
}

// A task + N tool-turns (assistant tool_use paired with its tool_result).
function buildHistory(turns: number, resultChars = 120): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: "user", content: "TASK: complete the assignment carefully" }];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "assistant", content: [{ callId: `c${i}`, name: "Read", input: { n: i } }] });
    msgs.push({ role: "tool", content: { callId: `c${i}`, result: "X".repeat(resultChars), isError: false } });
  }
  return msgs;
}

// Every tool_result must have a matching tool_use and vice-versa.
function assertNoOrphans(messages: ModelMessage[]): void {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const tc of m.content as Array<{ callId: string }>) uses.add(tc.callId);
    } else if (m.role === "tool") {
      results.add((m.content as { callId: string }).callId);
    }
  }
  for (const id of results) assert.ok(uses.has(id), `orphaned tool_result ${id} (no matching tool_use)`);
  for (const id of uses) assert.ok(results.has(id), `orphaned tool_use ${id} (no matching tool_result)`);
}

describe("DropOldestContextCompactor", () => {
  it("is a no-op when the conversation is comfortably under the window", () => {
    const msgs = buildHistory(2);
    const out = compactor.compact(msgs, caps(100000));
    assert.equal(out, msgs, "returns the same array (no trimming)");
  });

  it("trims oldest tool-turns near the window, keeps the task + a summary marker", () => {
    const msgs = buildHistory(14);
    const before = estimateTokens(msgs);
    const out = compactor.compact(msgs, caps(400));
    assert.ok(out.length < msgs.length, "messages were trimmed");
    assert.ok(estimateTokens(out) < before, "token estimate reduced");
    assert.ok(estimateTokens(out) <= 400 * 0.9, "brought under the trigger high-water mark");
    // original task retained + a retained summary marker present.
    assert.match(out[0].content as string, /TASK: complete the assignment/);
    assert.ok(out.some((m) => typeof m.content === "string" && (m.content as string).includes(MARKER)), "summary marker present");
  });

  it("evicts at matched-pair granularity — NO orphaned tool_use/tool_result survives (D8)", () => {
    for (const turns of [8, 14, 25]) {
      const out = compactor.compact(buildHistory(turns), caps(300));
      assertNoOrphans(out);
    }
  });

  it("never produces two consecutive user-role messages (Anthropic alternation)", () => {
    const out = compactor.compact(buildHistory(14), caps(300));
    for (let i = 1; i < out.length; i++) {
      assert.ok(!(out[i - 1].role === "user" && out[i].role === "user"), `consecutive user messages at ${i}`);
    }
  });
});

describe("ToolRuntime + compactor integration", () => {
  const allowGate: ToolGate = { async decide() { return { allow: true }; } };
  const endingModel: ModelClient = { async createTurn() { return { toolCalls: [], stopReason: "end_turn", text: "done" }; } };

  it("history near contextWindow is trimmed, the turn CONTINUES (no fail-fast error), no orphans", async () => {
    const history = buildHistory(20);
    const events: AgentEvent[] = [];
    const out = await runTurn(
      { model: endingModel, tools: new Map<string, RuntimeTool>(), gate: allowGate, emit: (e) => events.push(e), compactor, capabilities: caps(400) },
      history,
    );
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"), "turn continued to a normal end");
    assert.ok(!events.some((e) => e.type === "turn" && e.phase === "error"), "no context_window_exceeded fail-fast (compactor present)");
    assert.ok(out.length < history.length, "the persisted conversation was compacted");
    assertNoOrphans(out);
  });

  it("a reactive provider context_window_exceeded compacts hard and recovers (turn continues)", async () => {
    // First call reports overflow (mapped typed error); the loop compacts hard and
    // retries, second call ends the turn.
    let call = 0;
    const overflowOnceModel: ModelClient = {
      async createTurn() {
        call++;
        if (call === 1) return { toolCalls: [], stopReason: "error", error: "context_window_exceeded" };
        return { toolCalls: [], stopReason: "end_turn", text: "recovered" };
      },
    };
    const events: AgentEvent[] = [];
    await runTurn(
      { model: overflowOnceModel, tools: new Map<string, RuntimeTool>(), gate: allowGate, emit: (e) => events.push(e), compactor, capabilities: caps(400) },
      buildHistory(20),
    );
    assert.equal(call, 2, "retried once after the overflow");
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "ended"), "recovered to a normal end");
    assert.ok(!events.some((e) => e.type === "turn" && e.phase === "error"), "the overflow did not become a terminal turn error");
  });
});
