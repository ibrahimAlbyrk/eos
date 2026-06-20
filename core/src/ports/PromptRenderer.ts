// PromptRenderer — the narrow render seam a core consumer depends on to turn a
// named template + variables into final text. PromptService satisfies this
// structurally; the container injects c.prompts. Keeping core behind this port
// (not the concrete PromptService) means core holds template IDs + variable
// maps, never prose — all LLM-facing text lives in manager/prompts/.

import type { VariableScope } from "../domain/prompt.ts";

export interface PromptRenderer {
  render(id: string, locals?: VariableScope, vars?: VariableScope): string;
}
