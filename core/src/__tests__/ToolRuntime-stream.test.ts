import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type ToolGate } from "../use-cases/ToolRuntime.ts";
import type { ModelClient, ModelStreamCallbacks } from "../ports/ModelClient.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const allowGate: ToolGate = { async decide() { return { allow: true }; } };

function tag(e: AgentEvent): string {
  switch (e.type) {
    case "delta": return `delta:${e.channel}:${e.phase}:${e.blockId}`;
    case "message": return `msg:${e.blocks.map((b) => `${b.type}#${(b as { blockId?: string }).blockId ?? ""}`).join(",")}`;
    case "turn": return `turn:${e.phase}`;
    default: return e.type;
  }
}

describe("ToolRuntime — streaming model emits canonical deltas + durable blocks", () => {
  it("streams reasoning/text deltas, closes them, then emits durable blocks with matching blockIds", async () => {
    const model: ModelClient = {
      async createTurn() { return { toolCalls: [], stopReason: "end_turn" }; },
      async streamTurn(_m, cb: ModelStreamCallbacks) {
        cb.onReasoningDelta?.("let me ");
        cb.onReasoningDelta?.("think");
        cb.onTextDelta?.("answer");
        return { reasoning: "let me think", text: "answer", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const events: AgentEvent[] = [];
    await runTurn({ model, tools: new Map(), gate: allowGate, emit: (e) => events.push(e) }, [{ role: "user", content: "hi" }]);
    assert.deepEqual(events.map(tag), [
      "turn:started",
      "delta:reasoning:start:inproc-0-r",
      "delta:reasoning:append:inproc-0-r",
      "delta:text:start:inproc-0-t",
      "delta:reasoning:stop:inproc-0-r",
      "delta:text:stop:inproc-0-t",
      "msg:reasoning#inproc-0-r",
      "msg:text#inproc-0-t",
      "usage",
      "context",
      "turn:ended",
    ]);
  });

  it("falls back to createTurn (no deltas) when the model does not stream", async () => {
    const model: ModelClient = { async createTurn() { return { text: "hi", toolCalls: [], stopReason: "end_turn" }; } };
    const events: AgentEvent[] = [];
    await runTurn({ model, tools: new Map(), gate: allowGate, emit: (e) => events.push(e) }, [{ role: "user", content: "hi" }]);
    assert.equal(events.some((e) => e.type === "delta"), false);
    assert.ok(events.some((e) => e.type === "message"));
  });
});
