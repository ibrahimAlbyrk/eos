import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { editPage, pageIdArg } from "./page_shared.ts";

export const appendToPageDef: ToolDefinition = {
  name: "append_to_page",
  visibility: "worker",
  inputSchema: {
    id: pageIdArg,
    text: z.string().min(1).describe("Markdown to add. Checklist items use '- [ ] item'."),
    under_heading: z
      .string()
      .optional()
      .describe("Add at the end of this heading's section (matched by text, any level); the heading is created at the end of the page when missing. Omit to add at the end of the page."),
  },
  handler: async (ctx, args) => {
    const { id, text, under_heading } = args as { id: string; text: string; under_heading?: string };
    return editPage(ctx, id, { op: "append", text, ...(under_heading ? { heading: under_heading } : {}) });
  },
};
