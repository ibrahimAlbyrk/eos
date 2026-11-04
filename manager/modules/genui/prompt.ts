// The prompt variables visual answers fill: GENUI_LEVEL is the guidance line
// for the user's level (rich | balanced | text; absent → balanced), GENUI_OFF
// drops the rest of the visual-answers fragments when the user wants text only.

import { normalizeGenuiLevel, renderGenuiLevel } from "../../../core/src/services/render-genui-level.ts";

export function genuiPromptVariables(level?: string): { GENUI_LEVEL: string; GENUI_OFF: boolean } {
  return { GENUI_LEVEL: renderGenuiLevel(level), GENUI_OFF: normalizeGenuiLevel(level) === "text" };
}
