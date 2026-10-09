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
  decide(input: { workerId: string; toolName: string; input: Record<string, unknown>; agentId?: string | null; fullSurface?: boolean }): Promise<PolicyDecision>;
}

// A focused session runs the full Claude Code surface: the blocked builtins pass
// through to the gateway (which then skips its own block), and AskUserQuestion is
// answered in the dashboard's question banner. Returns the answers keyed by
// question text (AskUserQuestion's own shape), or null when the operator didn't answer.
export interface FullSurfaceOptions {
  askUser(questions: unknown, toolUseId: string, signal: AbortSignal): Promise<Record<string, string> | null>;
}

// A view a Task subagent presents lands inside its collapsed run, never in the
// transcript the user reads, so the subagent would report a view nobody saw.
const VIEW_TOOL = /^mcp__(?:orchestrator|worker)__present(?:_app)?$/;

export function makeCanUseTool(workerId: string, policy: PolicyDecider, fullSurface?: FullSurfaceOptions): CanUseTool {
  return async (toolName, input, opts): Promise<PermissionResult> => {
    if (fullSurface && toolName === "AskUserQuestion") {
      const answers = await fullSurface.askUser(input.questions, opts.toolUseID, opts.signal);
      return answers
        ? { behavior: "allow", updatedInput: { ...input, answers } }
        : { behavior: "deny", message: "The user dismissed the question without answering. Proceed on your best judgment." };
    }
    // Blocked builtins are hard-denied platform-wide with a tool-keyed message
    // (single source: contracts/src/tool-scope.ts).
    if (!fullSurface && isBlockedBuiltinTool(toolName)) {
      return { behavior: "deny", message: blockedBuiltinToolMessage(toolName) };
    }
    if (opts?.agentID && VIEW_TOOL.test(toolName)) {
      return { behavior: "deny", message: `${toolName} is main-agent only — return your findings; the main agent presents them.` };
    }
    const d = await policy.decide({ workerId, toolName, input, ...(fullSurface ? { fullSurface: true } : {}) });
    return d.behavior === "allow"
      ? { behavior: "allow", updatedInput: d.updatedInput ?? input }
      : { behavior: "deny", message: d.message ?? "denied by policy" };
  };
}
