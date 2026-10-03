import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { editPage, pageIdArg } from "./page_shared.ts";

export const setPageTaskDef: ToolDefinition = {
  name: "set_page_task",
  visibility: "worker",
  inputSchema: {
    id: pageIdArg,
    task: z.string().min(1).describe("The checklist item's text (or a part of it that matches only that item)."),
    done: z.boolean().default(true).describe("true ticks the item, false unticks it."),
  },
  handler: async (ctx, args) => {
    const { id, task, done } = args as { id: string; task: string; done: boolean };
    return editPage(ctx, id, { op: "setTask", task, done });
  },
};
