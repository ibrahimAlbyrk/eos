// Read — return a file's contents with `cat -n`-style line numbers (1-based,
// right-padded, tab-separated), matching the bundled binary so a model trained on
// that surface reads identically. offset (1-based start line) + limit (default
// 2000 lines) bound large files.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath, optionalNumber } from "./_shared.ts";

const DEFAULT_LIMIT = 2000;

export function createReadTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Read,
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        offset: { type: "number", description: "1-based line number to start from." },
        limit: { type: "number", description: "Maximum number of lines to read (default 2000)." },
      },
      required: ["file_path"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.file_path);
      const content = await fs.readFile(path);
      if (content.length === 0) return "(file is empty)";
      const lines = content.split("\n");
      // A trailing newline yields a final empty element; drop it so line counts match.
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const offset = Math.max(1, optionalNumber(input, "offset") ?? 1);
      const limit = optionalNumber(input, "limit") ?? DEFAULT_LIMIT;
      const start = offset - 1;
      const slice = lines.slice(start, start + limit);
      return slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join("\n");
    },
  };
}
