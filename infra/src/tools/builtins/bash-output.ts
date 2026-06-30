// BashOutput — read new output from a background shell started by Bash
// (run_in_background). Incremental: each call returns only output since the prior
// read, plus the shell's running/exit status. Canonical field: bash_id.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ProcessRunner } from "../../../../core/src/ports/ProcessRunner.ts";
import { requireString } from "./_shared.ts";

export function createBashOutputTool(proc: ProcessRunner): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.BashOutput,
    description: "Read new output from a running or completed background shell (by its bash_id).",
    schema: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: "The background shell id returned by Bash." },
      },
      required: ["bash_id"],
    },
    async execute(input) {
      const id = requireString(input, "bash_id");
      const r = proc.readBackground(id);
      if (!r) throw new Error(`no background shell with id ${id}`);
      const parts: string[] = [];
      if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
      if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
      parts.push(r.running ? "[status: running]" : `[status: completed, exit code ${r.exitCode}]`);
      return parts.join("\n");
    },
  };
}
