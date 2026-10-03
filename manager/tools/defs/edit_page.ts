import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { editPage, pageIdArg } from "./page_shared.ts";

export const editPageDef: ToolDefinition = {
  name: "edit_page",
  visibility: "worker",
  inputSchema: {
    id: pageIdArg,
    old_text: z.string().min(1).describe("Exact passage to replace, copied from read_page. Must occur exactly once."),
    new_text: z.string().describe("Replacement markdown. Empty string deletes the passage."),
  },
  handler: async (ctx, args) => {
    const { id, old_text, new_text } = args as { id: string; old_text: string; new_text: string };
    return editPage(ctx, id, { op: "replace", oldText: old_text, newText: new_text });
  },
};
