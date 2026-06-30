// Bridge: the SDK's canUseTool callback over Eos's permission engine. It hits the
// SAME PolicyGatewayService (explicit rules / per-worker mode / policy.yaml /
// long-poll ask) the claude-cli gateway hook uses, so the SDK lane is at parity
// with the PTY lane — and canUseTool is the SINGLE decision authority (the
// PreToolUse/PostToolUse hooks only emit activity, they never decide).

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isBlockedBuiltinTool, blockedBuiltinToolMessage } from "../../../contracts/src/tool-scope.ts";

export interface PolicyDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// Minimal seam the bridge needs — the container adapts the real
// PolicyGatewayService onto it. `agentId` (optional) flags a sub-agent caller so
// the gateway's rung-0.5 caller-scope check can hard-deny Eos control tools for
// nested Task subagents (the API lane has no native agent_id hook).
export interface PolicyDecider {
  decide(input: { workerId: string; toolName: string; input: Record<string, unknown>; agentId?: string | null }): Promise<PolicyDecision>;
}

export function makeCanUseTool(workerId: string, policy: PolicyDecider): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    // Blocked builtins are hard-denied platform-wide with a tool-keyed message
    // (single source: contracts/src/tool-scope.ts).
    if (isBlockedBuiltinTool(toolName)) {
      return { behavior: "deny", message: blockedBuiltinToolMessage(toolName) };
    }
    const d = await policy.decide({ workerId, toolName, input });
    return d.behavior === "allow"
      ? { behavior: "allow", updatedInput: d.updatedInput ?? input }
      : { behavior: "deny", message: d.message ?? "denied by policy" };
  };
}
