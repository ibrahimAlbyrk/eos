// Edit — replace a unique occurrence of old_string with new_string in a file.
// old_string must be present and unique unless replace_all is set. Canonical
// fields: file_path, old_string, new_string, replace_all?.

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath, requireString, applyStringEdit } from "./_shared.ts";

export function createEditTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.Edit,
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        old_string: { type: "string", description: "The exact text to replace (must be unique unless replace_all)." },
        new_string: { type: "string", description: "The replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.file_path);
      const oldString = requireString(input, "old_string");
      const newString = requireString(input, "new_string");
      const replaceAll = input.replace_all === true;
      const content = await fs.readFile(path);
      const updated = applyStringEdit(content, oldString, newString, replaceAll);
      await fs.writeFile(path, updated);
      return `Edited ${path}`;
    },
  };
}
