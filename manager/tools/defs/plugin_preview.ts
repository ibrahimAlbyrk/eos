import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { PluginPreviewRequestSchema, PluginPreviewSurfaceSchema } from "../../../contracts/src/plugin.ts";

export const pluginPreviewDef: ToolDefinition = {
  name: "plugin_preview",
  visibility: "worker",
  searchHint: "eos plugin preview screenshot picture look design check render view",
  inputSchema: {
    id: z.string().describe("The plugin's id (its folder name)."),
    surface: PluginPreviewSurfaceSchema.optional().describe("main = a mainView, panel = a sidePanelTab, header = the headerRight widgets. Default: the first the plugin registered, in that order."),
    view: z.string().optional().describe("Which mainView / sidePanelTab id to draw; default the first."),
    store: z.record(z.unknown()).optional().describe("Sample values for useStore keys, used only in the preview (the user's data is never touched). Keys left out read the real stored value."),
    width: z.number().int().optional().describe("Width in px. Default: main 1000, panel 420, header 760."),
    height: z.number().int().optional().describe("Height in px. Default: main 760, panel 760, header 56."),
    waitMs: z.number().int().optional().describe("Let entrance animations play this long before the picture is taken. Default 700."),
  },
  handler: async (ctx, args) => {
    const { id, ...body } = args as { id: string } & Record<string, unknown>;
    return ctx.api("POST", ROUTES.pluginPreview(id), PluginPreviewRequestSchema.parse(body));
  },
};
