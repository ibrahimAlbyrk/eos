// Facade over the prompt system: render(id, locals?) returns the final text.
// Globals auto-fill from a static scope + session vars (ctx.vars) + lazy
// variable providers; locals override. A provider runs only when the template
// references one of its declared keys — render is async only because providers
// may be.

import type { VariableScope } from "../domain/prompt.ts";
import type { VariableContext, VariableProvider } from "../ports/VariableProvider.ts";
import type { PromptRegistry } from "./PromptRegistry.ts";
import { renderTemplate } from "./template-engine.ts";
import { resolveVariables } from "./variable-resolve.ts";

export class PromptService {
  private readonly registry: PromptRegistry;
  private readonly providers: VariableProvider[];
  private readonly globals: VariableScope;

  constructor(registry: PromptRegistry, providers: VariableProvider[] = [], globals: VariableScope = {}) {
    this.registry = registry;
    this.providers = providers;
    this.globals = globals;
  }

  async render(id: string, locals: VariableScope = {}, ctx: VariableContext = {}): Promise<string> {
    const tpl = this.registry.get(id);
    const needed = new Set<string>(tpl.referenced);

    const providerValues: VariableScope = {};
    for (const provider of this.providers) {
      if (provider.keys.some((k) => needed.has(k))) {
        Object.assign(providerValues, await provider.provide(ctx));
      }
    }

    // Global tier: static globals < session vars < provider values. Locals (the
    // render argument) override all of them; an unresolved name renders empty.
    const sessionVars = (ctx.vars ?? {}) as VariableScope;
    const globals = { ...this.globals, ...sessionVars, ...providerValues };
    const scope = resolveVariables({ referenced: tpl.referenced, locals, globals });
    return renderTemplate(tpl.nodes, scope);
  }
}
