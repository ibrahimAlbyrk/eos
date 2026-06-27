// Edge port-type assignability — the P3 rule the node-editor enforces at draw
// time. MIRRORED VERBATIM from the contract source of truth
// (contracts/src/workflow-graph.ts `isPortTypeAssignable` + `PORT_TYPES`); the
// production bundle can't ergonomically import across the contracts package
// boundary (same reason api/routes.js shadows the route table). portTypes.test.js
// imports the REAL contract function and asserts this mirror matches it across
// every type pair, so the two can never silently diverge.

// contracts/src/workflow-graph.ts:34 — PORT_TYPES
export const PORT_TYPES = ["any", "string", "number", "boolean", "object", "array", "json"];

// contracts/src/workflow-graph.ts:44 — isPortTypeAssignable. `any` is the untyped
// escape hatch (assignable both ways); `json` and `object` interchange; otherwise
// the two concrete types must match exactly.
export function isPortTypeAssignable(from, to) {
  if (from === "any" || to === "any") return true;
  if (from === to) return true;
  if ((from === "json" && to === "object") || (from === "object" && to === "json")) return true;
  return false;
}
