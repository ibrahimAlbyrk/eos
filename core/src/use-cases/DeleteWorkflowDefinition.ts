// DeleteWorkflowDefinition — remove a per-owner runtime workflow definition (the
// symmetric mirror of CreateWorkflowDefinition). Deletes ONLY a runtime/SQLite-
// stored definition: a builtin is code shipped with Eos and is rejected, an
// unknown name is a clean not-found. File-based defs in ~/.eos/workflows are owned
// by the filesystem (the user edits those files) and are out of scope — a name
// that only exists as a file therefore falls through to the not-found path.

import { NotFoundError, ValidationError } from "../errors/index.ts";
import type { RuntimeWorkflowDefinitionStore } from "../ports/RuntimeWorkflowDefinitionStore.ts";

export interface DeleteWorkflowDefinitionDeps {
  store: RuntimeWorkflowDefinitionStore;
  // Builtins are code, not removable — supplied by the manager (which owns the
  // builtin source); core never imports it.
  isBuiltin(_name: string): boolean;
}

export interface DeleteWorkflowDefinitionInput {
  ownerId: string;
  name: string;
}

export function deleteWorkflowDefinition(
  deps: DeleteWorkflowDefinitionDeps,
  input: DeleteWorkflowDefinitionInput,
): { name: string } {
  // Try the runtime store FIRST: a runtime def that shadows a builtin of the same
  // name is legitimately removable (it only drops the runtime overlay; the builtin
  // code remains).
  if (deps.store.delete(input.ownerId, input.name)) return { name: input.name };
  if (deps.isBuiltin(input.name)) {
    throw new ValidationError(
      `cannot delete builtin workflow "${input.name}" — builtins are code, not removable`,
    );
  }
  throw new NotFoundError("workflow definition", input.name);
}
