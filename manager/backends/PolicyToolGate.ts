// Lane B gate: ToolRuntime's ToolGate over the SAME PolicyGatewayService the
// claude-cli (gateway hook) and claude-sdk (canUseTool) lanes use — per-worker,
// fail-closed via ToolRuntime.executeGated. The internal 'ask' verdict blocks as
// an await inside policy.decide (no TTL). Reuses the PolicyDecider seam the SDK
// permission bridge defines, so all three lanes share one decision engine.

import type { ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { PolicyDecider } from "./sdk/SdkPermissionBridge.ts";
import { isBlockedBuiltinTool, blockedBuiltinToolMessage } from "../../contracts/src/tool-scope.ts";

export function makePolicyToolGate(workerId: string, policy: PolicyDecider): ToolGate {
  return {
    async decide(toolName, input) {
      if (isBlockedBuiltinTool(toolName)) return { allow: false, message: blockedBuiltinToolMessage(toolName) };
      const d = await policy.decide({ workerId, toolName, input });
      return d.behavior === "allow" ? { allow: true } : { allow: false, message: d.message };
    },
  };
}
