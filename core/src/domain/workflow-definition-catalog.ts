// Pure, deterministic, Clock-free available-workflows catalog render — the LIST
// counterpart of renderWorkerDefinitionCatalog, for the orchestrator prompt. Folds
// the name-keyed last-wins dedup in directly (the same precedence resolveWorkflow-
// Definition applies): records arrive concatenated builtin → user/project → runtime,
// so a later record of the same name overrides an earlier one's value while keeping
// the first-seen position stable. One render-only helper suffices — the resolver
// already owns find-one precedence; this owns the LIST shaping.

import type { AnyWorkflowDefinitionRecord } from "../../../contracts/src/workflow-graph.ts";

// Accepts v1 tree records AND v2 graph records — both carry name/description/
// argsSchema, the only fields the catalog renders.
export function renderWorkflowDefinitionCatalog(records: AnyWorkflowDefinitionRecord[]): string {
  const byName = new Map<string, AnyWorkflowDefinitionRecord>();
  for (const rec of records) byName.set(rec.name, rec);
  return [...byName.values()]
    .map((r) => {
      const desc = (r.description || "").replace(/\s+/g, " ").trim();
      const head = desc ? `- ${r.name}: ${desc}` : `- ${r.name}`;
      const hint = argHint(r.argsSchema);
      return hint ? `${head} ${hint}` : head;
    })
    .join("\n");
}

// argsSchema is an opaque JSON-Schema (z.unknown). When it names properties, list
// them so the orchestrator knows which args the workflow takes; otherwise just flag
// that it accepts args.
function argHint(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "";
  const props = (schema as { properties?: unknown }).properties;
  if (props && typeof props === "object") {
    const keys = Object.keys(props as Record<string, unknown>);
    if (keys.length) return `(args: ${keys.join(", ")})`;
  }
  return "(takes args)";
}
