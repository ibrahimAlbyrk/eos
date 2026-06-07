// Worker action registry — maps the predefined UI actions (composer git
// buttons) to a prompt template, its variable values, and the short display
// label the chat renders instead of the full prompt. Adding an action is one
// row here (+ a template file if it doesn't share an existing one).

import type { WorkerAction } from "../../contracts/src/http.ts";
import type { PromptTemplateService } from "./PromptTemplateService.ts";

interface ActionSpec {
  template: string;
  display: string;
  args: string[];
}

const ACTIONS: Record<WorkerAction, ActionSpec> = {
  "commit":      { template: "commit.md",    display: "/commit",          args: ["false"] },
  "commit-push": { template: "commit.md",    display: "/commit and push", args: ["true"] },
  "pr":          { template: "create-pr.md", display: "/create-pr",       args: ["false"] },
  "draft-pr":    { template: "create-pr.md", display: "/create-pr draft", args: ["true"] },
  "verify":      { template: "verify.md",    display: "/verify",          args: [] },
};

export interface ResolvedAction {
  prompt: string;
  display: string;
}

export function resolveWorkerAction(
  templates: PromptTemplateService,
  action: WorkerAction,
): ResolvedAction {
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`unknown action: ${action}`);
  return { prompt: templates.render(spec.template, spec.args), display: spec.display };
}
