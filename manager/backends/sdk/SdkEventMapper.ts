// Anti-Corruption Layer: Claude Agent SDK messages -> canonical AgentEvents.
// Stateful per session (tracks the open turn + which live blocks were opened) so
// it can synthesize a stable blockId and apply lazy-open. SDK fields are read
// structurally (the SDK's Beta* types are large); the shapes below are the subset
// we depend on, verified against @anthropic-ai/claude-agent-sdk 0.3.x + the
// validated Python probes (content_block_delta -> thinking_delta/text_delta).

import type { AgentEvent, ContentBlock, CanonicalUsage } from "../../../contracts/src/canonical.ts";
import { contextTokensOf } from "../../../contracts/src/canonical.ts";

// --- the SDK message subset we read (structural) ---------------------------
interface RawDelta { type: string; text?: string; thinking?: string }
interface RawBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }
// message_start carries the stable Anthropic message id (msg_…); content_block_*
// events do not, so the mapper tracks it across the message's stream.
interface RawStreamEvent { type: string; index?: number; delta?: RawDelta; content_block?: RawBlock; message?: { id?: string } }
// Anthropic per-response usage. Present on the turn-final `result` (a turn
// aggregate → billing) AND on each `assistant` message (that one request → the
// context-window footprint). Same shape, read from two places.
interface SdkUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }
interface SdkMsg {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  event?: RawStreamEvent;
  message?: { id?: string; content?: RawBlock[] | string; usage?: SdkUsage };
  usage?: SdkUsage;
  model?: string;
  // Set on a subagent's (Task/Agent tool) internal messages — the parent Agent
  // tool_use id. Drives subagent attribution: inner tools surface as parented
  // activity grouped under the agentRun, not as top-level main-stream blocks.
  parent_tool_use_id?: string | null;
}

// Cache-creation tokens split by TTL tier (the price table charges 1h higher
// than 5m). Prefer the SDK's per-tier breakdown; fall back to the flat total as
// 5m when only it is present (older shapes), so cost is never double-counted.
function cacheWriteTokens(u: NonNullable<SdkMsg["usage"]>): Record<string, number> {
  const cc = u.cache_creation;
  if (cc && ((cc.ephemeral_5m_input_tokens ?? 0) > 0 || (cc.ephemeral_1h_input_tokens ?? 0) > 0)) {
    return {
      ...(cc.ephemeral_5m_input_tokens ? { "5m": cc.ephemeral_5m_input_tokens } : {}),
      ...(cc.ephemeral_1h_input_tokens ? { "1h": cc.ephemeral_1h_input_tokens } : {}),
    };
  }
  return u.cache_creation_input_tokens ? { "5m": u.cache_creation_input_tokens } : {};
}

function toCanonicalUsage(u: SdkUsage, model: string | null): CanonicalUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: cacheWriteTokens(u),
    model,
  };
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as RawBlock).text ?? "") : "")).join("");
  }
  return "";
}

// Map a complete assistant content block to a canonical block, stamping the SAME
// blockId the live deltas used (msgId:globalIndex) so the UI reconciles live <->
// durable. globalIndex is the block's position WITHIN THE MESSAGE (startIdx + i),
// not its position in this SDKMessage's content array — the SDK can split one
// message into several `assistant` SDKMessages (one per block), each a length-1
// array, so the array position would collide every split block at 0.
function durableBlocks(msgId: string, content: RawBlock[], startIdx: number): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  content.forEach((b, i) => {
    const blockId = `${msgId}:${startIdx + i}`;
    if (b.type === "text") blocks.push({ type: "text", text: b.text ?? "", blockId });
    else if (b.type === "thinking") {
      if ((b.thinking ?? "").trim()) blocks.push({ type: "reasoning", text: b.thinking ?? "", blockId });
    } else if (b.type === "tool_use") {
      blocks.push({ type: "tool_call", callId: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
    }
  });
  return blocks;
}

export interface SdkEventMapper {
  map(msg: SdkMsg): AgentEvent[];
  readonly sessionId: string | null;
}

export function createSdkEventMapper(): SdkEventMapper {
  let turnActive = false;
  let sessionId: string | null = null;
  const openedBlocks = new Map<string, "reasoning" | "text">(); // blockId -> channel of open live blocks
  // The blockId must be stable across every delta of one content block AND match
  // the durable assistant block (UI handoff). The SDK's per-partial `uuid` is NOT
  // stable (a fresh UUID per stream_event), so it can't anchor the id — the
  // Anthropic message id (from message_start) is. `msgEpoch` is a defensive
  // fallback that bumps per message so the id stays per-block-stable even if a
  // message_start is ever missing.
  let msgEpoch = 0;
  let currentMsgId: string | null = null;
  const blockBase = (): string => currentMsgId ?? `m${msgEpoch}`;
  // Per-message running block count — turns each split `assistant` SDKMessage's
  // local content index into the block's global position within the message, so
  // durable blockIds match the streamed content_block indices. Cleared per turn.
  const msgBlockCount = new Map<string, number>();

  const startTurn = (out: AgentEvent[]): void => {
    if (!turnActive) { turnActive = true; out.push({ type: "turn", phase: "started" }); }
  };

  return {
    get sessionId() { return sessionId; },
    map(msg: SdkMsg): AgentEvent[] {
      const out: AgentEvent[] = [];
      if (msg.session_id && !sessionId) sessionId = msg.session_id;

      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") out.push({ type: "session", phase: "ready", sessionId: msg.session_id });
          return out;

        case "stream_event": {
          const ev = msg.event;
          if (!ev) return out;
          // Subagent-internal streaming (parent_tool_use_id set) is NOT relayed live
          // into the parent view — the subagent's tools surface as parented activity
          // when its assistant message completes (handled in the "assistant" case).
          if (msg.parent_tool_use_id) return out;
          startTurn(out);
          if (ev.type === "message_start") {
            // New assistant message — anchor the stable blockId for its blocks.
            msgEpoch++;
            currentMsgId = ev.message?.id ?? null;
            return out;
          }
          if (ev.type === "content_block_stop" && ev.index !== undefined) {
            const stopId = `${blockBase()}:${ev.index}`;
            const ch = openedBlocks.get(stopId);
            if (ch) { openedBlocks.delete(stopId); out.push({ type: "delta", channel: ch, phase: "stop", blockId: stopId, text: "" }); }
            return out;
          }
          if (ev.type !== "content_block_delta" || ev.index === undefined || !ev.delta) return out;
          const blockId = `${blockBase()}:${ev.index}`;
          const d = ev.delta;
          // Only reasoning/text stream live; input_json_delta (tool args),
          // signature_delta and citations_delta share the channel and are dropped.
          const channel = d.type === "thinking_delta" ? "reasoning" : d.type === "text_delta" ? "text" : null;
          if (!channel) return out;
          const text = channel === "reasoning" ? (d.thinking ?? "") : (d.text ?? "");
          if (!openedBlocks.has(blockId)) {
            if (!text) return out; // lazy-open: defer until the first non-empty token
            openedBlocks.set(blockId, channel);
            out.push({ type: "delta", channel, phase: "start", blockId, text });
          } else {
            out.push({ type: "delta", channel, phase: "append", blockId, text });
          }
          return out;
        }

        case "assistant": {
          startTurn(out);
          const content = Array.isArray(msg.message?.content) ? (msg.message!.content as RawBlock[]) : [];
          // Subagent-internal assistant message: surface only its tool_use blocks as
          // PARENTED activity so the UI groups them under the agentRun (the Agent
          // tool); its text/reasoning are internal, summarized by the Agent's result.
          if (msg.parent_tool_use_id) {
            for (const b of content) {
              if (b.type === "tool_use") out.push({ type: "activity", kind: "tool_started", callId: b.id ?? null, toolName: b.name, input: b.input ?? {}, parentCallId: msg.parent_tool_use_id });
            }
            return out;
          }
          // Same anchor the live deltas used (message id), so durable blockIds
          // match and the UI hands off live -> durable instead of double-rendering.
          const msgId = msg.message?.id ?? blockBase();
          const startIdx = msgBlockCount.get(msgId) ?? 0;
          // Close any live blocks this message finalizes (the durable block takes over).
          content.forEach((_b, i) => {
            const blockId = `${msgId}:${startIdx + i}`;
            const ch = openedBlocks.get(blockId);
            if (ch) { openedBlocks.delete(blockId); out.push({ type: "delta", channel: ch, phase: "stop", blockId, text: "" }); }
          });
          msgBlockCount.set(msgId, startIdx + content.length);
          // Top-level tools surface FULLY as the tool_call block here (and a
          // tool_result block in the "user" case) — so, per the canonical
          // ActivityEvent contract ("backends whose tools surface fully as message
          // blocks omit them"), NO tool_started activity is emitted. One carrier
          // per tool ⇒ the UI cannot render it twice. Activities stay reserved for
          // subagent inner tools (the parent_tool_use_id branch above), which have
          // no standalone block.
          const blocks = durableBlocks(msgId, content, startIdx);
          if (blocks.length) out.push({ type: "message", role: "assistant", blocks });
          // Context-window occupancy: this top-level assistant message carries its
          // own API request's usage (BetaMessage.usage). Its prompt footprint
          // (in + cacheRead + cacheWrite) IS the live context occupancy; emit it
          // as a snapshot so the latest one of the turn wins. Subagent messages
          // returned above (parent_tool_use_id) — their context is separate, so
          // they never touch the parent's ring. Skip zero (a blockless split that
          // carries no usage must not clobber the real value with 0).
          const mu = msg.message?.usage;
          if (mu) {
            const tokens = contextTokensOf(toCanonicalUsage(mu, null));
            if (tokens > 0) out.push({ type: "context", tokens });
          }
          return out;
        }

        case "user": {
          // Tool results are fed back as a user message (a plain user turn carries
          // no tool_result and rides user_message instead).
          const content = Array.isArray(msg.message?.content) ? (msg.message!.content as RawBlock[]) : [];
          const results = content.filter((b) => b.type === "tool_result");
          if (!results.length) return out;
          for (const r of results) {
            // Subagent inner tool result → parented activity carrying the result, so
            // the agentRun shows it under the agent (it has no durable main-stream
            // block). A top-level result surfaces FULLY as the tool_result message
            // block below — so, like the tool_call side, it emits NO tool_finished
            // activity (one carrier per tool; the contract reserves activity for the
            // block-less subagent case).
            if (msg.parent_tool_use_id) {
              out.push({ type: "activity", kind: "tool_finished", callId: r.tool_use_id ?? null, result: blockText(r.content), isError: !!r.is_error, parentCallId: msg.parent_tool_use_id });
            } else {
              out.push({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: r.tool_use_id ?? "", isError: !!r.is_error, content: blockText(r.content) }] });
            }
          }
          return out;
        }

        case "result": {
          // result.usage is the TURN aggregate (summed over every API request +
          // subagents) — correct for cumulative billing, NOT context occupancy.
          // Occupancy rides per-message `context` events from the assistant case.
          out.push({ type: "usage", usage: toCanonicalUsage(msg.usage ?? {}, msg.model ?? null) });
          turnActive = false;
          currentMsgId = null; // next turn's message_start re-anchors
          msgBlockCount.clear();
          // A result subtype of error_* (e.g. error_max_turns, error_during_execution)
          // is a failed turn — surface it as turn:error so the worker doesn't idle as
          // if it succeeded; success ends the turn normally.
          const errored = typeof msg.subtype === "string" && msg.subtype.startsWith("error");
          out.push(errored ? { type: "turn", phase: "error", reason: msg.subtype } : { type: "turn", phase: "ended" });
          return out;
        }

        default:
          return out;
      }
    },
  };
}
