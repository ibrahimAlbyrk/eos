// Write — overwrite (or create) a file with the given content, creating missing
// parent directories. Canonical fields: file_path, content.

import { dirname } from "node:path";
import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath, requireString } from "./_shared.ts";

export function createWriteTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Write,
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        content: { type: "string", description: "The full content to write." },
      },
      required: ["file_path", "content"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.file_path);
      const content = requireString(input, "content");
      await fs.ensureDir(dirname(path));
      await fs.writeFile(path, content);
      return `Wrote ${content.length} bytes to ${path}`;
    },
  };
}
