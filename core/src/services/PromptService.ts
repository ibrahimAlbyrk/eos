// Facade over the prompt system: render(id, locals?, vars?) returns the final
// text. Precedence (high→low): locals (per-call) → session vars → static globals.
// Synchronous — every variable source is already-resolved data (no providers,
// no I/O): the system prompt is assembled once at launch from plain values.

import type { ParsedPrompt, VariableScope } from "../domain/prompt.ts";
import type { PromptRegistry } from "./PromptRegistry.ts";
import { parseTemplate, renderTemplate } from "./template-engine.ts";
import { resolveVariables } from "./variable-resolve.ts";

export class PromptService {
  private readonly registry: PromptRegistry;
  private readonly globals: VariableScope;

  constructor(registry: PromptRegistry, globals: VariableScope = {}) {
    this.registry = registry;
    this.globals = globals;
  }

  render(id: string, locals: VariableScope = {}, vars: VariableScope = {}): string {
    return this.renderParsed(this.registry.get(id), locals, vars);
  }

  // Render directly from an already-parsed template's own AST instead of a
  // registry-id lookup. The DPI pipeline uses this for synthetic fragments
  // (e.g. a worker-definition body) whose id is not in the registry — render(id)
  // would throw NotFoundError on them.
  renderParsed(tpl: ParsedPrompt, locals: VariableScope = {}, vars: VariableScope = {}): string {
    const globals = { ...this.globals, ...vars };
    const scope = resolveVariables({ referenced: tpl.referenced, locals, globals });
    return renderTemplate(tpl.nodes, scope);
  }

  // Render an ad-hoc template body that is NOT in the registry — for callers
  // carrying their own template string (e.g. a config-supplied override). Parses
  // on every call (no caching); prefer render(id) for catalog prompts. A
  // malformed body throws (parseTemplate is strict) — callers fail-close on it.
  renderInline(body: string, locals: VariableScope = {}, vars: VariableScope = {}): string {
    const { nodes, referenced } = parseTemplate(body);
    const globals = { ...this.globals, ...vars };
    const scope = resolveVariables({ referenced, locals, globals });
    return renderTemplate(nodes, scope);
  }
}
