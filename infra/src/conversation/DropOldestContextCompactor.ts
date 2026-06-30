// DropOldestContextCompactor — the default ContextCompactor (D8: drop-oldest, not
// summarize). When a conversation approaches capabilities.contextWindow, it evicts
// the OLDEST tool-turns and keeps the original task + the most-recent turns + a
// short retained summary marker, so a small-context model compacts instead of a
// raw 400. Cheap + deterministic; per-profile summarize is a later opt-in.
//
// D8 caution (the binding correctness rule): eviction is at whole tool-turn /
// MATCHED-PAIR granularity. The loop's messages alternate user-task → assistant
// (tool_use) → tool (tool_result)…; an assistant tool-call message and the tool
// messages that answer it form one unit and are kept/dropped together, so a dropped
// turn never orphans a tool_use without its tool_result (itself a 400 on Anthropic).

import type { ContextCompactor } from "../../../core/src/ports/ContextCompactor.ts";
import type { ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";
import { estimateTokens } from "../../../core/src/use-cases/ToolRuntime.ts";

const MARKER = "[Earlier tool-call history was truncated to fit the model's context window.]";
// Trigger compaction near the window; pack the retained tail to a lower target so
// there is headroom for the next request + response.
const TRIGGER_RATIO = 0.9;
const TARGET_RATIO = 0.7;

type Unit = ModelMessage[];

// Group messages into matched units: an assistant message plus the tool messages
// that answer it = one tool-turn unit; every other message (the user task, a plain
// assistant turn) is its own unit. Whole units are kept/dropped, never split.
function groupUnits(messages: ModelMessage[]): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "assistant") {
      const unit: Unit = [m];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") { unit.push(messages[j]); j++; }
      units.push(unit);
      i = j;
    } else {
      units.push([m]);
      i++;
    }
  }
  return units;
}

// Merge adjacent plain user-string messages so compaction never produces two
// consecutive user turns (the head task + the marker, or task1 + task2) — which
// would break wire alternation on the Anthropic dialect.
function coalesceUserStrings(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user" && typeof prev.content === "string" && typeof m.content === "string") {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` };
    } else {
      out.push(m);
    }
  }
  return out;
}

export class DropOldestContextCompactor implements ContextCompactor {
  compact(messages: ModelMessage[], capabilities: ProviderCapabilities): ModelMessage[] {
    const window = capabilities.contextWindow;
    if (estimateTokens(messages) <= window * TRIGGER_RATIO) return messages;

    const units = groupUnits(messages);
    // Need at least the original task + one droppable middle + a most-recent turn.
    if (units.length <= 2) return messages;

    const head = units[0];
    const packBudget = window * TARGET_RATIO;
    let used = estimateTokens(head) + estimateTokens([{ role: "user", content: MARKER }]);
    const keptTail: Unit[] = [];
    // Keep the most-recent units that fit; always keep at least one (the latest turn).
    for (let i = units.length - 1; i >= 1; i--) {
      const u = units[i];
      const cost = estimateTokens(u);
      if (keptTail.length > 0 && used + cost > packBudget) break;
      used += cost;
      keptTail.unshift(u);
    }
    // Nothing droppable (everything fit) → leave the conversation untouched.
    if (keptTail.length >= units.length - 1) return messages;

    const marker: ModelMessage = { role: "user", content: MARKER };
    return coalesceUserStrings([...head, marker, ...keptTail.flat()]);
  }
}
