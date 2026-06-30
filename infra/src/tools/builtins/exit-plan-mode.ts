// ExitPlanMode — surface parity with the bundled binary. Eos's PermissionMode is
// two-valued (acceptEdits / bypassPermissions) with NO "plan" mode, so there is no
// plan-mode state to exit; the tool is present for surface parity and acknowledges
// the plan without changing any mode. Canonical field: plan.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";

export function createExitPlanModeTool(): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.ExitPlanMode,
    description: "Signal that planning is complete and present the plan. (Eos has no plan permission mode; this is a no-op acknowledgment.)",
    schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan to present before proceeding." },
      },
      required: ["plan"],
    },
    async execute() {
      return "Acknowledged. (Eos has no plan permission mode — proceed with the work.)";
    },
  };
}
