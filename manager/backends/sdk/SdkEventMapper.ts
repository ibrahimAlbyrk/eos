// Anti-Corruption Layer: Claude Agent SDK messages -> canonical AgentEvents.
// Stateful per session (tracks the open turn + which live blocks were opened) so
// it can synthesize a stable blockId and apply lazy-open. SDK fields are read
// structurally (the SDK's Beta* types are large); the shapes below are the subset
// we depend on, verified against @anthropic-ai/claude-agent-sdk 0.3.x + the
// validated Python probes (content_block_delta -> thinking_delta/text_delta).

import type { AgentEvent, ContentBlock, CanonicalUsage, SubagentUsage } from "../../../contracts/src/canonical.ts";
import { contextTokensOf, parseStructuredPatch } from "../../../contracts/src/canonical.ts";

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
// Background-task usage rides system/task_notification with its own shape.
interface SdkTaskUsage { total_tokens?: number; tool_uses?: number; duration_ms?: number }
interface SdkMsg {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  event?: RawStreamEvent;
  message?: { id?: string; content?: RawBlock[] | string; usage?: SdkUsage };
  // Anthropic usage on `result` messages; task usage on system/task_notification.
  // Intersection (all fields optional) so both readers stay type-safe.
  usage?: SdkUsage & SdkTaskUsage;
  model?: string;
  // system task_notification / task_started fields (SDKTaskNotificationMessage /
  // SDKTaskStartedMessage). task_id IS the background agent's agentId — verified
  // against the async_launched stub's agentId at runtime.
  task_id?: string;
  tool_use_id?: string;
  status?: string;
  output_file?: string;
  summary?: string;
  // Set on a subagent's (Task/Agent tool) internal messages — the parent Agent
  // tool_use id. Drives subagent attribution: inner tools surface as parented
  // activity grouped under the agentRun, not as top-level main-stream blocks.
  parent_tool_use_id?: string | null;
  // SDKUserMessage sidecar riding alongside a tool_result — for Edit/Write it
  // plausibly carries the same { structuredPatch } the CLI transcript does. Read
  // structurally (unknown) and narrowed defensively via parseStructuredPatch: the
  // runtime shape is unverified, so a missing/garbage sidecar just yields no patch.
  tool_use_result?: unknown;
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

// --- background-subagent carriers -------------------------------------------
// A background Agent launch resolves its tool_result to the async_launched stub.
// The structured AgentOutput rides the SDKUserMessage tool_use_result sidecar
// (preferred); the result block itself carries only rendered stub TEXT, parsed
// as a fallback (adapters may normalize raw carriers; the UI never will).

interface AsyncStub { agentId: string; description?: string; outputFile?: string }

function parseAsyncStubSidecar(tur: unknown): AsyncStub | null {
  if (!tur || typeof tur !== "object") return null;
  const o = tur as { status?: unknown; agentId?: unknown; description?: unknown; outputFile?: unknown };
  if (o.status !== "async_launched" || typeof o.agentId !== "string") return null;
  return {
    agentId: o.agentId,
    ...(typeof o.description === "string" ? { description: o.description } : {}),
    ...(typeof o.outputFile === "string" ? { outputFile: o.outputFile } : {}),
  };
}

function parseAsyncStubText(text: string): AsyncStub | null {
  if (!text.startsWith("Async agent launched")) return null;
  const agentId = /\bagentId:\s*([\w-]+)/.exec(text)?.[1];
  if (!agentId) return null;
  const outputFile = /\boutput_file:\s*(\S+)/.exec(text)?.[1];
  return { agentId, ...(outputFile ? { outputFile } : {}) };
}

// The true completion also rides an injected plain user turn (<task-notification>
// XML, origin kind "task-notification") — the only carrier of the agent's FULL
// final text (<result>). One turn can batch several notification blocks.
interface NotificationCarrier { taskId: string; toolUseId?: string; status: "completed" | "failed" | "stopped"; outputFile?: string; summary?: string; result?: string }

function normalizeTaskStatus(s: string | undefined): "completed" | "failed" | "stopped" {
  return s === "failed" || s === "stopped" ? s : "completed";
}

function parseNotificationCarriers(text: string): NotificationCarrier[] {
  const out: NotificationCarrier[] = [];
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const block = m[1];
    const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1].trim();
    const taskId = tag("task-id");
    if (!taskId) continue;
    // <result> greedy to its LAST close tag — the agent's final text may itself
    // contain markup; the short fields stay non-greedy.
    const result = /<result>([\s\S]*)<\/result>/.exec(block)?.[1].trim();
    const toolUseId = tag("tool-use-id");
    const outputFile = tag("output-file");
    const summary = tag("summary");
    out.push({
      taskId,
      status: normalizeTaskStatus(tag("status")),
      ...(toolUseId ? { toolUseId } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(summary ? { summary } : {}),
      ...(result ? { result } : {}),
    });
  }
  return out;
}

function toSubagentUsage(u: SdkTaskUsage | undefined): SubagentUsage | undefined {
  if (!u) return undefined;
  const usage: SubagentUsage = {
    ...(u.total_tokens !== undefined ? { totalTokens: u.total_tokens } : {}),
    ...(u.tool_uses !== undefined ? { toolUses: u.tool_uses } : {}),
    ...(u.duration_ms !== undefined ? { durationMs: u.duration_ms } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
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
      // The SDK names the subagent tool "Agent"; mark it so all lanes converge on the
      // contract marker (the UI still also honors name === "Agent" for older events).
      blocks.push({ type: "tool_call", callId: b.id ?? "", name: b.name ?? "", input: b.input ?? {}, ...(b.name === "Agent" ? { spawnsSubagent: true } : {}) });
    }
  });
  return blocks;
}

export interface SdkEventMapper {
  map(msg: SdkMsg): AgentEvent[];
  readonly sessionId: string | null;
  // uuid of the last completed top-level assistant message — the recall anchor
  // (forkSession slices the transcript up to and including it). null until the
  // first assistant message of the session.
  readonly lastAssistantUuid: string | null;
}

export function createSdkEventMapper(): SdkEventMapper {
  let turnActive = false;
  let sessionId: string | null = null;
  let lastAssistantUuid: string | null = null;
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

  // Background-subagent correlation. agentCallIds: top-level Agent/Task tool_use
  // ids — the gate that keeps non-subagent task notifications (background Bash,
  // Monitor, workflows share the task system) from emitting subagent events.
  // bgAgents: agentId (≡ task_id) → spawn info. pendingSummary marks a completion
  // already reported from the system notification (summary-only) so the injected
  // user-turn carrier upgrades it with the full <result> instead of re-reporting.
  // announced marks subagent_started as emitted — the entry may pre-exist it
  // (system task_started beats the stub on the live stream), so entry existence
  // alone must not suppress the announcement.
  interface BgEntry { callId: string | null; outputFile?: string; usage?: SubagentUsage; pendingSummary?: boolean; announced?: boolean }
  const agentCallIds = new Set<string>();
  const bgAgents = new Map<string, BgEntry>();

  const pushCompleted = (out: AgentEvent[], agentId: string, entry: BgEntry, c: { callId?: string | null; status: "completed" | "failed" | "stopped"; result?: string; outputFile?: string; usage?: SubagentUsage }): void => {
    out.push({
      type: "subagent_completed",
      agentId,
      callId: c.callId ?? entry.callId,
      status: c.status,
      ...(c.result ? { result: c.result } : {}),
      ...(c.outputFile ?? entry.outputFile ? { outputFile: (c.outputFile ?? entry.outputFile)! } : {}),
      ...(c.usage ?? entry.usage ? { usage: (c.usage ?? entry.usage)! } : {}),
    });
  };

  // Resolve (or, when the spawning call is a known Agent/Task tool_use, create)
  // the bgAgents entry a completion carrier refers to — creation covers a stub
  // the mapper missed (e.g. unparseable text with no sidecar).
  const resolveBgEntry = (taskId: string, toolUseId: string | undefined): BgEntry | undefined => {
    const entry = bgAgents.get(taskId);
    if (entry) return entry;
    if (!toolUseId || !agentCallIds.has(toolUseId)) return undefined;
    const fresh: BgEntry = { callId: toolUseId };
    bgAgents.set(taskId, fresh);
    return fresh;
  };

  const startTurn = (out: AgentEvent[]): void => {
    if (!turnActive) { turnActive = true; out.push({ type: "turn", phase: "started" }); }
  };

  return {
    get sessionId() { return sessionId; },
    get lastAssistantUuid() { return lastAssistantUuid; },
    map(msg: SdkMsg): AgentEvent[] {
      const out: AgentEvent[] = [];
      if (msg.session_id && !sessionId) sessionId = msg.session_id;

      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") out.push({ type: "session", phase: "ready", sessionId: msg.session_id });
          // Background-task true completion (SDKTaskNotificationMessage) — fires
          // out-of-band the moment the task stops. Carries summary + usage only;
          // the full final text follows on the injected user-turn carrier, which
          // upgrades this event (see the plain-user branch of the "user" case).
          else if (msg.subtype === "task_notification" && msg.task_id) {
            const entry = resolveBgEntry(msg.task_id, msg.tool_use_id);
            if (entry) {
              entry.usage = toSubagentUsage(msg.usage) ?? entry.usage;
              if (msg.output_file) entry.outputFile = msg.output_file;
              entry.pendingSummary = true;
              pushCompleted(out, msg.task_id, entry, {
                callId: msg.tool_use_id,
                status: normalizeTaskStatus(msg.status),
                ...(msg.summary ? { result: msg.summary } : {}),
              });
            }
          }
          // task_started only backfills the task_id→callId map — live it routinely
          // arrives BEFORE the stub. It never emits events (it also fires for
          // foreground subagents); subagent_started comes from the async_launched
          // stub, which is background-only.
          else if (msg.subtype === "task_started" && msg.task_id && msg.tool_use_id) {
            resolveBgEntry(msg.task_id, msg.tool_use_id);
          }
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
          // Track the last completed top-level assistant message uuid — the recall
          // anchor (the entry the SDK transcript is sliced to on recall). Subagent
          // messages returned above never set it.
          if (msg.uuid) lastAssistantUuid = msg.uuid;
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
          // Remember top-level subagent-spawning callIds — the gate for mapping
          // this call's async stub / task notifications to subagent events.
          for (const b of content) {
            if (b.type === "tool_use" && b.id && (b.name === "Agent" || b.name === "Task")) agentCallIds.add(b.id);
          }
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
          if (!results.length) {
            // Plain user turns are otherwise dropped — but the injected
            // <task-notification> carrier (the CLI's turn-start delivery of a
            // background task's completion) is the only source of the agent's
            // FULL final text. Mine it: upgrade a summary-only completion already
            // emitted from the system notification, or report the completion
            // outright if that notification never arrived on the stream.
            if (msg.parent_tool_use_id) return out;
            const text = blockText(msg.message?.content);
            if (!text.includes("<task-notification>")) return out;
            for (const c of parseNotificationCarriers(text)) {
              const entry = resolveBgEntry(c.taskId, c.toolUseId);
              if (!entry) continue; // not a subagent task (background Bash/Monitor/workflow)
              const alreadyReported = entry.pendingSummary === true;
              entry.pendingSummary = false;
              if (alreadyReported && !c.result) continue; // nothing to add over the summary
              pushCompleted(out, c.taskId, entry, {
                callId: c.toolUseId,
                status: c.status,
                ...(c.result ?? c.summary ? { result: (c.result ?? c.summary)! } : {}),
                ...(c.outputFile ? { outputFile: c.outputFile } : {}),
              });
            }
            return out;
          }
          // Edit/Write's absolute-line-number patch rides the message-level
          // tool_use_result sidecar (not the result block). Parse defensively —
          // undefined for non-Edit tools or an unexpected sidecar shape.
          const patch = parseStructuredPatch(
            (msg.tool_use_result as { structuredPatch?: unknown } | undefined)?.structuredPatch,
          );
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
              out.push({ type: "message", role: "tool", blocks: [{ type: "tool_result", callId: r.tool_use_id ?? "", isError: !!r.is_error, content: blockText(r.content), ...(patch ? { patch } : {}) }] });
              // Background launch: the stub result confirms the async spawn. The
              // structured sidecar is authoritative; stub-text parse is the
              // fallback, gated on a known Agent/Task call so arbitrary tool text
              // can't fake a spawn. Foreground runs (status "completed") match
              // neither and emit nothing.
              const stub = parseAsyncStubSidecar(msg.tool_use_result)
                ?? (agentCallIds.has(r.tool_use_id ?? "") ? parseAsyncStubText(blockText(r.content)) : null);
              if (stub && r.tool_use_id) {
                const entry = bgAgents.get(stub.agentId) ?? { callId: r.tool_use_id };
                if (!entry.announced) {
                  entry.callId = r.tool_use_id;
                  if (stub.outputFile) entry.outputFile = stub.outputFile;
                  entry.announced = true;
                  bgAgents.set(stub.agentId, entry);
                  out.push({
                    type: "subagent_started",
                    callId: r.tool_use_id,
                    agentId: stub.agentId,
                    background: true,
                    ...(stub.description ? { description: stub.description } : {}),
                    ...(stub.outputFile ? { outputFile: stub.outputFile } : {}),
                  });
                }
              }
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
