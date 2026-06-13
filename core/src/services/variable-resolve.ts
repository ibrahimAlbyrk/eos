// Merge the resolution tiers into the final render scope. Precedence, highest
// first: local (per-call) → global (static + session vars + provider-supplied).
// A name with no value at any tier resolves to undefined (renders empty) —
// there are no required variables or declared defaults (kept deliberately
// simple; the `variables:` manifest is documentation, not a type system).

import type { VariableScope } from "../domain/prompt.ts";

export interface ResolveInput {
  referenced: string[];
  locals: VariableScope;
  globals: VariableScope;
}

export function resolveVariables(input: ResolveInput): VariableScope {
  const { referenced, locals, globals } = input;
  const scope: VariableScope = {};
  for (const name of referenced) {
    if (Object.hasOwn(locals, name)) scope[name] = locals[name];
    else if (Object.hasOwn(globals, name)) scope[name] = globals[name];
    else scope[name] = undefined;
  }
  return scope;
}
