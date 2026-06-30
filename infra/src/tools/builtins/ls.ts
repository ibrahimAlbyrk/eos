// LS — list the entries of a directory (directories first, with a trailing slash).
// Canonical field: path. Resolves cwd-relative like the other filesystem tools.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath } from "./_shared.ts";

export function createLsTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.LS,
    description: "List the files and directories of a given path.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or cwd-relative directory path." },
      },
      required: ["path"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.path);
      const entries = await fs.readDir(path);
      if (entries.length === 0) return "(empty directory)";
      const sorted = entries
        .slice()
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1,
        );
      return sorted.map((e) => (e.type === "directory" ? `${e.name}/` : e.name)).join("\n");
    },
  };
}
