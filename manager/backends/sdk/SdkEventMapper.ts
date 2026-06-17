// Anti-Corruption Layer: Claude Agent SDK messages -> canonical AgentEvents.
// Stateful per session (tracks the open turn + which live blocks were opened) so
// it can synthesize a stable blockId and apply lazy-open. SDK fields are read
// structurally (the SDK's Beta* types are large); the shapes below are the subset
// we depend on, verified against @anthropic-ai/claude-agent-sdk 0.3.x + the
// validated Python probes (content_block_delta -> thinking_delta/text_delta).

import type { AgentEvent, ContentBlock } from "../../../contracts/src/canonical.ts";

// --- the SDK message subset we read (structural) ---------------------------
interface RawDelta { type: string; text?: string; thinking?: string }
interface RawBlock { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }
// message_start carries the stable Anthropic message id (msg_…); content_block_*
// events do not, so the mapper tracks it across the message's stream.
interface RawStreamEvent { type: string; index?: number; delta?: RawDelta; content_block?: RawBlock; message?: { id?: string } }
interface SdkMsg {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  event?: RawStreamEvent;
  message?: { id?: string; content?: RawBlock[] | string };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string;
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
function durableBlocks(msgId: string, content: RawBlock[], startIdx: number): { blocks: ContentBlock[]; toolCalls: RawBlock[] } {
  const blocks: ContentBlock[] = [];
  const toolCalls: RawBlock[] = [];
  content.forEach((b, i) => {
    const blockId = `${msgId}:${startIdx + i}`;
    if (b.type === "text") blocks.push({ type: "text", text: b.text ?? "", blockId });
    else if (b.type === "thinking") {
      if ((b.thinking ?? "").trim()) blocks.push({ type: "reasoning", text: b.thinking ?? "", blockId });
    } else if (b.type === "tool_use") {
      blocks.push({ type: "tool_call", callId: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
      toolCalls.push(b);
    }
  });
  return { blocks, toolCalls };
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
          const { blocks, toolCalls } = durableBlocks(msgId, content, startIdx);
          if (blocks.length) out.push({ type: "message", role: "assistant", blocks });
          for (const tc of toolCalls) out.push({ type: "activity", kind: "tool_started", callId: tc.id ?? null, toolName: tc.name });
          return out;
        }

        case "user": {
          // Tool results are fed back as a user message — surface them as a tool
          // message + tool_finished activity (plain user turns ride user_message).
          const content = Array.isArray(msg.message?.content) ? (msg.message!.content as RawBlock[]) : [];
          const results = content.filter((b) => b.type === "tool_result");
          if (!results.length) return out;
          for (const r of results) {
            out.push({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: r.tool_use_id ?? "", isError: !!r.is_error, content: blockText(r.content) }] });
            out.push({ type: "activity", kind: "tool_finished", callId: r.tool_use_id ?? null });
          }
          return out;
        }

        case "result": {
          const u = msg.usage ?? {};
          out.push({ type: "usage", usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ? { "5m": u.cache_creation_input_tokens } : {},
            model: msg.model ?? null,
          } });
          turnActive = false;
          currentMsgId = null; // next turn's message_start re-anchors
          msgBlockCount.clear();
          out.push({ type: "turn", phase: "ended" });
          return out;
        }

        default:
          return out;
      }
    },
  };
}
