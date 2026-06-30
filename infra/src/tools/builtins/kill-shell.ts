// KillShell — terminate a background shell started by Bash (run_in_background).
// Canonical field: shell_id. (Both KillShell and KillBash route to the shell
// category in permission-mode; the registry authors the KillShell spelling.)

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ProcessRunner } from "../../../../core/src/ports/ProcessRunner.ts";
import { requireString } from "./_shared.ts";

export function createKillShellTool(proc: ProcessRunner): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.KillShell,
    schema: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: "The background shell id to kill." },
      },
      required: ["shell_id"],
    },
    async execute(input) {
      const id = requireString(input, "shell_id");
      const killed = proc.killBackground(id);
      if (!killed) throw new Error(`no background shell with id ${id}`);
      return `Killed background shell ${id}`;
    },
  };
}
