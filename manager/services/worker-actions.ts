// Worker action registry — maps the predefined UI actions (composer git
// buttons) to a prompt id, its variable values, and the short display label the
// chat renders instead of the full prompt. Adding an action is one row here
// (+ a prompt file if it doesn't share an existing one). Prompts resolve
// through the centralized PromptService (Layer 1).

import type { WorkerAction } from "../../contracts/src/http.ts";
import type { VariableScope } from "../../core/src/domain/prompt.ts";
import type { PromptService } from "../../core/src/services/PromptService.ts";

interface ActionSpec {
  prompt: string;
  display: string;
  vars: VariableScope;
}

const ACTIONS: Record<WorkerAction, ActionSpec> = {
  "commit":      { prompt: "commit",    display: "/commit",          vars: { PUSH: "false" } },
  "commit-push": { prompt: "commit",    display: "/commit and push", vars: { PUSH: "true" } },
  "pr":          { prompt: "create-pr", display: "/create-pr",       vars: { DRAFT: "false" } },
  "draft-pr":    { prompt: "create-pr", display: "/create-pr draft", vars: { DRAFT: "true" } },
  "verify":      { prompt: "verify",    display: "/verify",          vars: {} },
};

export interface ResolvedAction {
  prompt: string;
  display: string;
}

export async function resolveWorkerAction(
  prompts: PromptService,
  action: WorkerAction,
): Promise<ResolvedAction> {
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`unknown action: ${action}`);
  const prompt = (await prompts.render(spec.prompt, spec.vars)).trim();
  return { prompt, display: spec.display };
}
