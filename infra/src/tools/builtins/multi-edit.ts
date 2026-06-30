// MultiEdit — apply a sequence of Edit operations to one file atomically (each
// edit sees the prior edit's result; any failure aborts the whole batch with no
// write). Canonical fields: file_path, edits[] (each old_string/new_string/replace_all?).

import { BUILTIN_TOOL_NAMES } from "../../../../contracts/src/builtin-tools.ts";
import type { BuiltinTool } from "../../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ToolFileSystem } from "../../../../core/src/ports/ToolFileSystem.ts";
import { resolveToolPath, applyStringEdit } from "./_shared.ts";

export function createMultiEditTool(fs: ToolFileSystem): BuiltinTool {
  return {
    name: BUILTIN_TOOL_NAMES.MultiEdit,
    description: "Apply multiple sequential string edits to a single file in one atomic operation.",
    schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute or cwd-relative path to the file." },
        edits: {
          type: "array",
          description: "Edits applied in order; each sees the previous edit's result.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["file_path", "edits"],
    },
    async execute(input, ctx) {
      const path = resolveToolPath(ctx, input.file_path);
      const edits = input.edits;
      if (!Array.isArray(edits) || edits.length === 0) throw new Error("'edits' must be a non-empty array");
      let content = await fs.readFile(path);
      edits.forEach((e, i) => {
        const edit = e as Record<string, unknown>;
        if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
          throw new Error(`edit ${i + 1}: 'old_string' and 'new_string' are required strings`);
        }
        content = applyStringEdit(content, edit.old_string, edit.new_string, edit.replace_all === true);
      });
      await fs.writeFile(path, content);
      return `Applied ${edits.length} edit(s) to ${path}`;
    },
  };
}
