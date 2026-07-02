// In-process subagent attribution — the anti-corruption layer between a Task
// child's own ToolRuntime event stream and the parent worker's stream. Mirrors
// SdkEventMapper's subagent branch (parent_tool_use_id): the child's inner tools
// surface as PARENTED activity grouped under the parent Task's agentRun, and the
// child's text/reasoning/turn/context are dropped — the Task's finalText is its
// summary. Kept pure (canonical AgentEvent in/out) so it is unit-testable without
// the session scaffolding.

import type { AgentEvent } from "../../contracts/src/canonical.ts";

// Map ONE canonical event the child's runTurn emits into zero or more events for
// the parent stream, attributed to `taskCallId` (the parent Task tool_call's id):
//   • child tool_call  → activity tool_started { parentCallId: taskCallId }
//   • child tool_result → activity tool_finished { parentCallId: taskCallId }
//   • usage             → forwarded verbatim (the child's tokens bill onto the parent)
//   • everything else (assistant text/reasoning/skill, turn, delta, context, session)
//     → dropped: it is internal to the subagent, summarized by the Task result.
export function mapSubagentEvent(taskCallId: string, e: AgentEvent): AgentEvent[] {
  if (e.type === "usage") return [e];
  if (e.type !== "message") return [];
  if (e.role === "assistant") {
    return e.blocks
      .filter((b) => b.type === "tool_call")
      .map((b) => ({ type: "activity", kind: "tool_started", callId: b.callId, toolName: b.name, input: b.input ?? {}, parentCallId: taskCallId }));
  }
  if (e.role === "tool") {
    return e.blocks
      .filter((b) => b.type === "tool_result")
      .map((b) => ({ type: "activity", kind: "tool_finished", callId: b.callId, result: b.content ?? "", isError: !!b.isError, parentCallId: taskCallId }));
  }
  return [];
}
