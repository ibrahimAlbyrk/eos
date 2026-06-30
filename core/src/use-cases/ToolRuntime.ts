// ToolRuntime — the Eos-hosted agentic loop for backends that do NOT run their
// own loop (anthropic-api / openai / codex). It drives a ModelClient: call the
// model → if it returns tool calls, gate + execute each → feed results back →
// repeat until the model ends the turn. The claude-cli backend does NOT use this
// (the CLI runs its own loop); this is what makes "any LLM API" a viable backend.
//
// Backend-agnostic + pure: it emits canonical AgentEvents (contracts/canonical)
// and gates EVERY tool through a single chokepoint (fail-closed — an unknown tool
// or a denied decision yields an error tool_result, never a skipped gate). No
// Node imports.

import type { ModelClient, ModelMessage } from "../ports/ModelClient.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { contextTokensOf } from "../../../contracts/src/canonical.ts";

export interface RuntimeTool {
  name: string;
  execute(input: Record<string, unknown>): Promise<string>;
}

export interface ToolGate {
  // Returns allow=false to deny (its message becomes the tool_result text). On
  // allow, an optional updatedInput is the policy's rewritten input (rewrite
  // rules / human-edited "ask" approvals) — executeGated runs the tool on it.
  decide(toolName: string, input: Record<string, unknown>): Promise<{ allow: boolean; message?: string; updatedInput?: Record<string, unknown> }>;
}

export interface ToolRuntimeDeps {
  model: ModelClient;
  tools: Map<string, RuntimeTool>;
  gate: ToolGate;
  emit(event: AgentEvent): void;
  /** Hard ceiling on model round-trips per turn (runaway guard). Default 50. */
  maxIterations?: number;
  /** Cooperative cancellation — checked between round-trips (interrupt). */
  signal?: { aborted: boolean };
}

export async function runTurn(deps: ToolRuntimeDeps, conversation: ModelMessage[]): Promise<ModelMessage[]> {
  const messages = conversation.slice();
  const max = deps.maxIterations ?? 50;
  deps.emit({ type: "turn", phase: "started" });

  for (let i = 0; i < max; i++) {
    if (deps.signal?.aborted) {
      deps.emit({ type: "turn", phase: "aborted", reason: "interrupted" });
      return messages;
    }

    let turn;
    const blockR = `inproc-${i}-r`;
    const blockT = `inproc-${i}-t`;
    let openR = false;
    let openT = false;
    try {
      // Prefer streaming so reasoning/text arrive as live canonical deltas (the
      // SAME pipeline as the claude-sdk lane); fall back to one round-trip.
      turn = deps.model.streamTurn
        ? await deps.model.streamTurn(messages, {
            signal: deps.signal,
            onReasoningDelta: (t) => { deps.emit({ type: "delta", channel: "reasoning", phase: openR ? "append" : "start", blockId: blockR, text: t }); openR = true; },
            onTextDelta: (t) => { deps.emit({ type: "delta", channel: "text", phase: openT ? "append" : "start", blockId: blockT, text: t }); openT = true; },
          })
        : await deps.model.createTurn(messages);
    } catch (e) {
      deps.emit({ type: "turn", phase: "error", reason: e instanceof Error ? e.message : String(e) });
      return messages;
    }

    // Close live blocks before their durable counterpart lands (UI drops by blockId).
    if (openR) deps.emit({ type: "delta", channel: "reasoning", phase: "stop", blockId: blockR, text: "" });
    if (openT) deps.emit({ type: "delta", channel: "text", phase: "stop", blockId: blockT, text: "" });
    if (turn.reasoning) deps.emit({ type: "message", role: "assistant", blocks: [{ type: "reasoning", text: turn.reasoning, blockId: blockR }] });
    if (turn.text) deps.emit({ type: "message", role: "assistant", blocks: [{ type: "text", text: turn.text, blockId: blockT }] });
    if (turn.usage) {
      // Each loop iteration is one API call, so this usage IS a per-request
      // footprint: emit it as billing (summed) AND as a context snapshot (latest
      // wins). Same split the claude-sdk/claude-cli lanes use.
      const usage = { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, cacheReadTokens: turn.usage.cacheReadTokens ?? 0, cacheWriteTokens: {} };
      deps.emit({ type: "usage", usage });
      const tokens = contextTokensOf(usage);
      if (tokens > 0) deps.emit({ type: "context", tokens });
    }

    if (turn.stopReason === "error") {
      deps.emit({ type: "turn", phase: "error", reason: turn.error });
      return messages;
    }

    if (turn.toolCalls.length === 0) {
      deps.emit({ type: "turn", phase: "ended" });
      return messages;
    }

    messages.push({ role: "assistant", content: turn.toolCalls });

    for (const call of turn.toolCalls) {
      deps.emit({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: call.callId, name: call.name, input: call.input }] });
      const result = await executeGated(deps, call.name, call.input);
      deps.emit({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: call.callId, isError: result.isError, content: result.text }] });
      messages.push({ role: "tool", content: { callId: call.callId, result: result.text, isError: result.isError } });
    }
  }

  deps.emit({ type: "turn", phase: "aborted", reason: "max_iterations" });
  return messages;
}

// Single chokepoint: every tool call is gated here before execution, so
// "forgetting to gate" is unrepresentable. Denied / unknown / thrown → error
// result fed back to the model (never a silent skip).
async function executeGated(
  deps: ToolRuntimeDeps,
  name: string,
  input: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  let decision;
  try {
    decision = await deps.gate.decide(name, input);
  } catch (e) {
    return { text: `permission check failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
  if (!decision.allow) return { text: decision.message ?? "denied by policy", isError: true };

  const tool = deps.tools.get(name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true };

  try {
    return { text: await tool.execute(decision.updatedInput ?? input), isError: false };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
