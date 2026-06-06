// Pure translator: the Claude-CLI legacy wire events this worker emits
// (jsonl / hook / usage / tool_running / tool_done / heartbeat / lifecycle) →
// canonical backend-agnostic AgentEvents. This is the claude-cli backend's
// anti-corruption layer — the ONLY place that knows Claude's hook names and
// JSONL kinds. Kept Node-free + pure so it is unit-testable without the
// PTY/chokidar scaffolding, and so it imposes no runtime dependency (the
// canonical type import is erased by strip-types).

import type { AgentEvent } from "../contracts/src/canonical.ts";

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Map one legacy (type, payload) the claude-cli worker emits into zero or more
 * canonical AgentEvents. Unknown/irrelevant inputs return []. "state" pushes are
 * already backend-agnostic and are intentionally not translated here.
 */
export function toCanonicalEvents(type: string, payload: unknown): AgentEvent[] {
  const p = asRec(payload);
  switch (type) {
    case "jsonl":
      return jsonlToCanonical(p);
    case "usage":
      return [usageToCanonical(p)];
    case "hook":
      return hookToCanonical(p);
    case "tool_running":
      return [{ type: "activity", kind: "tool_started", toolName: str(p.toolName), callId: str(p.toolUseId) ?? null }];
    case "tool_done":
      return [{ type: "activity", kind: "tool_finished", toolName: str(p.toolName), callId: str(p.toolUseId) ?? null }];
    case "heartbeat":
      return [{ type: "activity", kind: "alive" }];
    case "lifecycle":
      return lifecycleToCanonical(p);
    default:
      return [];
  }
}

function jsonlToCanonical(p: Rec): AgentEvent[] {
  switch (str(p.kind)) {
    case "assistant_text":
      return [{ type: "message", role: "assistant", blocks: [{ type: "text", text: str(p.text) ?? "" }] }];
    case "thinking":
      return [{ type: "message", role: "assistant", blocks: [{ type: "reasoning", text: str(p.text) ?? "" }] }];
    case "tool_use":
      return [{
        type: "message",
        role: "assistant",
        blocks: [{ type: "tool_call", callId: str(p.id) ?? "", name: str(p.name) ?? "", input: asRec(p.input) }],
      }];
    case "tool_result":
      return [{
        type: "message",
        role: "tool",
        blocks: [{ type: "tool_result", callId: str(p.toolUseId) ?? "", isError: p.isError === true, content: str(p.text) ?? "" }],
      }];
    default:
      return [];
  }
}

function usageToCanonical(p: Rec): AgentEvent {
  // Flatten Claude's two cache-write tiers into the open per-tier map, omitting
  // zeros so the canonical shape stays clean for backends without caching.
  const cacheWriteTokens: Record<string, number> = {};
  const c5 = num(p.cacheCreate);
  const c1h = num(p.cacheCreate1h);
  if (c5 > 0) cacheWriteTokens["5m"] = c5;
  if (c1h > 0) cacheWriteTokens["1h"] = c1h;
  return {
    type: "usage",
    usage: {
      inputTokens: num(p.in),
      outputTokens: num(p.out),
      cacheReadTokens: num(p.cacheRead),
      cacheWriteTokens,
      model: str(p.model) ?? null,
    },
  };
}

function hookToCanonical(p: Rec): AgentEvent[] {
  const body = asRec(p.body);
  const toolName = str(body.tool_name);
  const callId = str(body.tool_use_id) ?? null;
  switch (str(p.event)) {
    case "PreToolUse":
      return [{ type: "activity", kind: "tool_started", toolName, callId }];
    case "PostToolUse":
      return [{ type: "activity", kind: "tool_finished", toolName, callId }];
    case "Stop":
      return [{ type: "turn", phase: "ended", reason: "stop" }];
    case "SessionStart":
      return [{ type: "session", phase: "started" }];
    case "SessionEnd":
      return [{ type: "session", phase: "ended" }];
    // Notification carries no state signal — mirror the legacy hook handler,
    // which ignores it (only PostToolUse / Stop / SessionEnd drive state).
    case "Notification":
      return [];
    default:
      return [];
  }
}

function lifecycleToCanonical(p: Rec): AgentEvent[] {
  switch (str(p.phase)) {
    case "claude_spawning":
      return [{ type: "session", phase: "started" }];
    case "ready_no_prompt":
    case "ready_timeout":
      return [{ type: "session", phase: "ready" }];
    case "prompt_sent":
    case "message_received":
      return [{ type: "turn", phase: "started" }];
    case "interrupted":
      return [{ type: "turn", phase: "aborted", reason: "interrupt" }];
    case "prompt_unacknowledged":
      return [{ type: "session", phase: "lost", reason: "prompt_unacknowledged" }];
    case "pty_exit": {
      const code = num(p.code);
      const outcome = code === 0 || code === 129 ? "success" : code === 143 ? "killed" : "crashed";
      return [{ type: "session", phase: "ended", outcome }];
    }
    default:
      return [];
  }
}
