import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { GENUI_LIMITS, GENUI_TONES, type ViewProblem, type ViewStats } from "../../../contracts/src/genui/catalog.ts";
import { presentSuccessText } from "../../../contracts/src/genui/spec.ts";
import { isSwitchedOff, problemsText, refusalOf } from "./present_shared.ts";

// Kept small and loose on purpose, in the manager's own zod (the shape each lane
// projects): the daemon's validator phrases every slip with its path, which a
// schema rejection can't. The catalog itself rides the tool description.
export const presentDef: ToolDefinition = {
  name: "present",
  visibility: "orchestrator",
  // The catalog rides this description: a focused session (tool search on) must see it from turn 1.
  alwaysLoad: true,
  inputSchema: {
    title: z.string().describe(`≤ ${GENUI_LIMITS.titleChars} chars`),
    tone: z.enum(GENUI_TONES).optional().describe("the view's one accent"),
    icon: z.string().optional().describe("an icon name from the catalog"),
    replaces: z.string().optional().describe("id of an earlier view (v_…) this one updates"),
    data: z.record(z.any()).optional().describe("collections (arrays of entities) and scalars, each written once"),
    actions: z.record(z.any()).optional().describe("{id: {label, kind, primary?, text?, href?, set?}}"),
    ui: z.string().describe("markup that references data"),
    summary: z.string().describe(`the answer as plain text, ≤ ${GENUI_LIMITS.summaryChars} chars`),
  },
  handler: async (ctx, args) => {
    let res: { viewId?: unknown; warnings?: ViewProblem[]; stats?: ViewStats; error?: unknown };
    try {
      res = (await ctx.api("POST", ROUTES.genuiViews, { input: args })) as typeof res;
    } catch (e) {
      const r = refusalOf(e);
      if (r.problems) throw new Error(problemsText("present", r.problems), { cause: e });
      if (isSwitchedOff(r)) return r.reason;
      throw new Error(r.reason, { cause: e });
    }
    if (typeof res?.viewId !== "string" || !res.stats) {
      return typeof res?.error === "string" ? res.error : "present: the daemon answered without a view id — nothing rendered";
    }
    return presentSuccessText(res.viewId, res.stats, { warnings: res.warnings ?? [] });
  },
};
