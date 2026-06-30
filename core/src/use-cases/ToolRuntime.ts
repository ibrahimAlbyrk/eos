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
import type { ContextCompactor } from "../ports/ContextCompactor.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
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
  /** The model's context window (tokens) for the M1 fail-fast pre-flight guard:
   *  before each model call, a cheap estimate of the conversation size is compared
   *  to this, and a turn that would overflow a small-context model aborts with a
   *  typed `context_window_exceeded` error rather than a raw provider 400. Used only
   *  as the fallback when no compactor is injected (tests). */
  contextWindow?: number;
  /** M4 — real context compaction, replacing the fail-fast guard. When present
   *  (with capabilities), the loop trims oldest tool-turns before each model call so
   *  a small-context model compacts instead of 400ing, and recovers a reactive
   *  provider `context_window_exceeded` by compacting harder and retrying once. */
  compactor?: ContextCompactor;
  /** Declared provider quirks the compactor reads (contextWindow). */
  capabilities?: ProviderCapabilities;
  /** The bare name of the Skill RuntimeTool, when one is on the surface (§5c). A
   *  successful call to it additionally emits a canonical `skill` block correlated
   *  by callId (the SKILL.md body, surfaced for the UI like the claude-cli lane) —
   *  the model still receives the body as the tool_result. Dispatch + gating are
   *  unchanged; absent ⇒ no skill block (tests, the claude lanes). */
  skillToolName?: string;
}

// Cheap token estimate (chars/4) over the conversation, for the pre-flight guard
// and the ContextCompactor (shared so both judge the window the same way).
// Deliberately approximate — it only needs to catch a small-context overflow
// before the provider 400s, not bill accurately.
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  return Math.ceil(chars / 4);
}

export async function runTurn(deps: ToolRuntimeDeps, conversation: ModelMessage[]): Promise<ModelMessage[]> {
  let messages = conversation.slice();
  const max = deps.maxIterations ?? 50;
  // One reactive (post-400) hard compaction per turn — bounds the retry so a
  // pathological overflow can't loop forever.
  let reactiveCompacted = false;
  deps.emit({ type: "turn", phase: "started" });

  for (let i = 0; i < max; i++) {
    if (deps.signal?.aborted) {
      deps.emit({ type: "turn", phase: "aborted", reason: "interrupted" });
      return messages;
    }

    // Near-window management before each model call. M4: a ContextCompactor trims
    // oldest matched tool-turns so a small-context model compacts (turn continues)
    // instead of 400ing. M1 fallback (no compactor injected — tests): the fail-fast
    // guard aborts with a typed error rather than a raw provider 400.
    if (deps.compactor && deps.capabilities) {
      messages = deps.compactor.compact(messages, deps.capabilities);
    } else if (deps.contextWindow && estimateTokens(messages) > deps.contextWindow * 0.9) {
      deps.emit({ type: "turn", phase: "error", reason: "context_window_exceeded" });
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
      // A mid-stream interrupt surfaces from the SSE parser as stopReason:"error",
      // error:"aborted" (ModelTurn has no "aborted" stop reason). Translate it to the
      // clean abort path so the FSM/UI sees turn:aborted, not turn:error (m1) — same
      // shape as the top-of-loop interrupt check.
      if (turn.error === "aborted") {
        deps.emit({ type: "turn", phase: "aborted", reason: "interrupted" });
        return messages;
      }
      // Recoverable provider overflow: an Anthropic model_context_window_exceeded
      // (mapped to this typed error by the client) means our estimate was too low.
      // Compact HARD (half the window) once and retry the same iteration; the
      // proactive pass next loop sees the trimmed set. Bounded by reactiveCompacted.
      if (turn.error === "context_window_exceeded" && deps.compactor && deps.capabilities && !reactiveCompacted) {
        reactiveCompacted = true;
        messages = deps.compactor.compact(messages, { ...deps.capabilities, contextWindow: Math.max(1, Math.floor(deps.capabilities.contextWindow * 0.5)) });
        i--;
        continue;
      }
      deps.emit({ type: "turn", phase: "error", reason: turn.error });
      return messages;
    }

    if (turn.toolCalls.length === 0) {
      // Persist the assistant's terminal TEXT turn into history before returning, so
      // the next user turn alternates roles (Anthropic 400s on two consecutive user
      // messages; the in-process lane pushes a fresh user message each turn) and every
      // dialect keeps the model's own prior answers (B1). A terminal non-tool turn
      // needs no signed-thinking re-emit, so it carries no providerMetadata — safe with
      // reasoningRoundTrip:"preserve-signed".
      if (turn.text) messages.push({ role: "assistant", content: turn.text });
      deps.emit({ type: "turn", phase: "ended" });
      return messages;
    }

    // Carry any opaque per-turn provider metadata (Anthropic signed `thinking`
    // blocks for reasoningRoundTrip:"preserve-signed") onto the pushed assistant
    // message so the next request re-emits it verbatim. Neutral: undefined on the
    // OpenAI lane (reasoning is dropped from history).
    messages.push({ role: "assistant", content: turn.toolCalls, ...(turn.providerMetadata ? { providerMetadata: turn.providerMetadata } : {}) });

    for (const call of turn.toolCalls) {
      deps.emit({ type: "message", role: "assistant", blocks: [{ type: "tool_call", callId: call.callId, name: call.name, input: call.input }] });
      const result = await executeGated(deps, call.name, call.input);
      deps.emit({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: call.callId, isError: result.isError, content: result.text }] });
      // A loaded skill body also surfaces as a canonical skill block (UI parity with
      // the claude-cli lane) — additive; the model already got the body above.
      if (deps.skillToolName && call.name === deps.skillToolName && !result.isError) {
        deps.emit({ type: "message", role: "assistant", blocks: [{ type: "skill", callId: call.callId, text: result.text }] });
      }
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
