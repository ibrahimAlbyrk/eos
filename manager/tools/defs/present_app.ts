import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { GENUI_LIMITS, formatProblem, type ViewProblem } from "../../../contracts/src/genui/catalog.ts";
import { appSuccessText } from "../../../contracts/src/genui/spec.ts";
import { isSwitchedOff, problemsText, refusalOf } from "./present_shared.ts";

export const presentAppDef: ToolDefinition = {
  name: "present_app",
  visibility: "orchestrator",
  searchHint: "sandboxed HTML app in the chat: calculator, timer, game, simulator, custom interactive visual",
  inputSchema: {
    title: z.string().describe(`≤ ${GENUI_LIMITS.titleChars} chars`),
    html: z.string().describe(`one self-contained HTML document, ≤ ${GENUI_LIMITS.appHtmlBytes / 1024} KB`),
    summary: z.string().describe(`what the app is and does, as plain text, ≤ ${GENUI_LIMITS.summaryChars} chars`),
    height: z.number().optional().describe(`initial height in px, ${GENUI_LIMITS.appHeightMin}–${GENUI_LIMITS.appHeightMax}`),
  },
  handler: async (ctx, args) => {
    let res: { viewId?: unknown; warnings?: ViewProblem[]; error?: unknown };
    try {
      res = (await ctx.api("POST", ROUTES.genuiApps, { input: args })) as typeof res;
    } catch (e) {
      const r = refusalOf(e);
      if (r.problems) throw new Error(problemsText("present_app", r.problems), { cause: e });
      // Apps switched off (or visual answers off altogether): the daemon's words are the answer.
      if (isSwitchedOff(r)) return r.reason;
      throw new Error(r.reason, { cause: e });
    }
    if (typeof res?.viewId !== "string") {
      return typeof res?.error === "string" ? res.error : "present_app: the daemon answered without a view id — nothing rendered";
    }
    const warnings = res.warnings ?? [];
    const head = appSuccessText(res.viewId);
    if (!warnings.length) return head;
    return [head, "warnings (fix next time, no need to re-present):", ...warnings.map((w) => `· ${formatProblem(w)}`)].join("\n");
  },
};
