// Pure render of the workflow engine's VOCABULARY — the node-type names and the
// transform-fn names the registries actually carry. Derived from
// StepExecutorRegistry.types() / TransformFnRegistry.names() at the composition root
// so the orchestrator prompt can never drift from the registry (adding an executor
// or a custom fn updates this list automatically). The per-node PARAM/semantics
// prose stays authored in the prompt; this owns only the canonical name roster.

export function renderCapabilityCatalog(nodeTypes: string[], transformFns: string[]): string {
  return [
    `Node types: ${nodeTypes.join(", ")}`,
    `Transform fns: ${transformFns.join(", ")}`,
  ].join("\n");
}
