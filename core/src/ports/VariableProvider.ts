// VariableProvider — supplies dynamic global variables. `keys` declares what it
// can provide so the resolver invokes it ONLY when a rendered template actually
// references one of them; a prompt that names no git variable never triggers a
// git call. Results are merged into the global tier (below locals).

import type { VariableScope } from "../domain/prompt.ts";

export interface VariableContext {
  // Session-supplied variables available for interpolation (Layer 2 fills these
  // from the spawn context, UPPER_SNAKE keys), plus the cwd a git/env provider
  // needs. Empty for standalone Layer-1 renders.
  vars?: Record<string, unknown>;
  cwd?: string | null;
}

export interface VariableProvider {
  readonly keys: readonly string[];
  provide(ctx: VariableContext): VariableScope | Promise<VariableScope>;
}
