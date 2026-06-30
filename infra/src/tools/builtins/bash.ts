// Bash — run a shell command, scoped to the worker's cwd, with a timeout. With
// run_in_background:true the shell is spawned detached and tracked by id (read via
// BashOutput, killed via KillShell). Canonical fields: command, timeout?,
// run_in_background?. A non-zero exit returns the output plus an exit-code note
// (not a thrown error), matching the bundled binary.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ProcessRunner } from "../../../../core/src/ports/ProcessRunner.ts";
import { requireString, optionalNumber } from "./_shared.ts";

const MAX_TIMEOUT_MS = 600_000;

export function createBashTool(proc: ProcessRunner): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Bash,
    description: "Execute a shell command in the worker's working directory. Supports an optional timeout and background execution.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout: { type: "number", description: "Timeout in ms (default 120000, max 600000)." },
        run_in_background: { type: "boolean", description: "Run detached and return a shell id (read via BashOutput)." },
      },
      required: ["command"],
    },
    async execute(input, ctx) {
      const command = requireString(input, "command");
      const requested = optionalNumber(input, "timeout");
      const timeoutMs = requested ? Math.min(requested, MAX_TIMEOUT_MS) : undefined;

      if (input.run_in_background === true) {
        const id = proc.startBackground(command, { cwd: ctx.cwd, timeoutMs });
        return `Background shell started with id ${id}. Use BashOutput (bash_id=${id}) to read output, KillShell (shell_id=${id}) to stop it.`;
      }

      const r = await proc.run(command, { cwd: ctx.cwd, timeoutMs });
      const parts: string[] = [];
      if (r.stdout) parts.push(r.stdout.replace(/\n$/, ""));
      if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, "")}`);
      if (r.timedOut) parts.push(`[command killed: timed out after ${timeoutMs ?? 120_000}ms]`);
      else if (r.exitCode !== 0 && r.exitCode !== null) parts.push(`[exit code: ${r.exitCode}]`);
      return parts.length > 0 ? parts.join("\n") : "(no output)";
    },
  };
}
