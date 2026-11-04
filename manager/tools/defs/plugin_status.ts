import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import type { PluginInfo, PluginReport } from "../../../contracts/src/plugin.ts";

interface StatusResponse {
  plugin: PluginInfo;
  report: PluginReport | null;
}

// Where a plugin stands after its files were written: built or not (and why),
// and whether the open Eos windows loaded it or it failed there.
function describe({ plugin: p, report }: StatusResponse) {
  const window = !p.enabled
    ? "turned off in Settings › Plugins — nothing loads"
    : !p.hasUi
      ? "no UI entry to load"
      : !report || report.rev < p.rev
        ? "not loaded in any window yet (is the Eos app open?)"
        : report.ok
          ? `build ${p.rev} loaded`
          : `build ${report.rev} failed in the window: ${report.error ?? "unknown error"}`;
  return {
    id: p.id,
    dir: p.dir,
    state: p.state,
    buildError: p.error,
    build: p.rev || null,
    window,
    settings: p.settings,
  };
}

export const pluginStatusDef: ToolDefinition = {
  name: "plugin_status",
  visibility: "worker",
  searchHint: "eos plugin status build error loaded ui widget sidebar header panel extend interface",
  inputSchema: {
    id: z.string().optional().describe("The plugin's id (its folder name). Omit to list every plugin and the folder they live in."),
  },
  handler: async (ctx, args) => {
    const { id } = args as { id?: string };
    if (!id) {
      const { plugins, dir } = (await ctx.api("GET", ROUTES.plugins)) as { plugins: PluginInfo[]; dir: string };
      return {
        pluginsDir: dir,
        plugins: plugins.map((p) => ({ id: p.id, name: p.manifest?.name ?? null, state: p.state, error: p.error })),
      };
    }
    try {
      return describe((await ctx.api("GET", `${ROUTES.pluginStatus(id)}?wait=1`)) as StatusResponse);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/daemon 404/.test(msg)) return { id, state: "missing", window: `no plugin folder "${id}" — create it (with plugin.json) in the plugins folder; call plugin_status with no id to see where that is` };
      throw e;
    }
  },
};
