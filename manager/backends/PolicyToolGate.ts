// Lane B gate: ToolRuntime's ToolGate over the SAME PolicyGatewayService the
// claude-cli (gateway hook) and claude-sdk (canUseTool) lanes use — per-worker,
// fail-closed via ToolRuntime.executeGated. The internal 'ask' verdict blocks as
// an await inside policy.decide (no TTL). Reuses the PolicyDecider seam the SDK
// permission bridge defines, so all three lanes share one decision engine.

import type { ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { PolicyDecider } from "./sdk/SdkPermissionBridge.ts";
import { isBlockedBuiltinTool, blockedBuiltinToolMessage } from "../../contracts/src/tool-scope.ts";

// opts.agentId marks the gate as a sub-agent caller (nested Task child): the
// gateway's rung-0.5 caller-scope check then hard-denies Eos control tools for it,
// defense-in-depth atop the child surface omitting those tools entirely (§5e).
export function makePolicyToolGate(workerId: string, policy: PolicyDecider, opts?: { agentId?: string }): ToolGate {
  return {
    async decide(toolName, input) {
      if (isBlockedBuiltinTool(toolName)) return { allow: false, message: blockedBuiltinToolMessage(toolName) };
      // Only thread agentId when present so the default (rung-0) call shape is
      // unchanged for the parent-worker gate.
      const d = await policy.decide(opts?.agentId ? { workerId, toolName, input, agentId: opts.agentId } : { workerId, toolName, input });
      return d.behavior === "allow" ? { allow: true, updatedInput: d.updatedInput } : { allow: false, message: d.message };
    },
  };
}
