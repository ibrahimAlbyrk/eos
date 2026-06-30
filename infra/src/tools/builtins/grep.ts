// Grep — search file contents with ripgrep (the bundled binary's engine), so regex
// dialect + speed match the SDK/CLI lanes. Canonical fields: pattern, path?,
// output_mode? (files_with_matches|content|count), -i?, -n?, glob?, type?, head_limit?.
// Runs through the ProcessRunner port (fakeable).

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ProcessRunner } from "../../../../core/src/ports/ProcessRunner.ts";
import { requireString, optionalNumber } from "./_shared.ts";

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function createGrepTool(proc: ProcessRunner): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Grep,
    description: "Search file contents with ripgrep. output_mode: files_with_matches (default), content, or count.",
    schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The ripgrep regular expression to search for." },
        path: { type: "string", description: "File or directory to search (defaults to the working directory)." },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        "-i": { type: "boolean", description: "Case-insensitive search." },
        "-n": { type: "boolean", description: "Show line numbers (content mode)." },
        glob: { type: "string", description: "Filter files by glob, e.g. *.ts" },
        type: { type: "string", description: "Filter by ripgrep file type, e.g. js" },
        head_limit: { type: "number", description: "Limit to the first N output lines." },
      },
      required: ["pattern"],
    },
    async execute(input, ctx) {
      const pattern = requireString(input, "pattern");
      const outputMode = typeof input.output_mode === "string" ? input.output_mode : "files_with_matches";
      const args: string[] = ["--color", "never"];
      if (outputMode === "files_with_matches") args.push("--files-with-matches");
      else if (outputMode === "count") args.push("--count");
      else if (input["-n"] === true) args.push("--line-number");
      if (input["-i"] === true) args.push("--ignore-case");
      if (typeof input.glob === "string" && input.glob) args.push("--glob", shQuote(input.glob));
      if (typeof input.type === "string" && input.type) args.push("--type", shQuote(input.type));
      args.push("--regexp", shQuote(pattern));
      // ALWAYS pass a search path — ripgrep with no path reads from stdin, which is
      // a never-closed pipe here and would block forever. Default to the cwd (".").
      args.push(typeof input.path === "string" && input.path ? shQuote(input.path) : ".");

      const r = await proc.run(`rg ${args.join(" ")}`, { cwd: ctx.cwd });
      // ripgrep: exit 0 = matches, 1 = no matches, ≥2 = error.
      if (r.exitCode === 1 && !r.stdout) return "(no matches)";
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        throw new Error(`grep failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      }
      let out = r.stdout.replace(/\n$/, "");
      const headLimit = optionalNumber(input, "head_limit");
      if (headLimit && headLimit > 0) out = out.split("\n").slice(0, headLimit).join("\n");
      return out || "(no matches)";
    },
  };
}
