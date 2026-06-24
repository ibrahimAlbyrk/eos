// predicate.ts — the Specification evaluator for `conditional` / `loopUntil`
// gates (§3.11). A pure function over the run's BindingScope: the operand refs
// (`left` / `ref`) are resolved against bindings before comparison. The operator
// set is deliberately closed (eq / exists / and / or — see PredicateSchema in
// contracts/workflow-node.ts), NOT a general expression language. Pure: no Node,
// no Date.now/Math.random.

import type { Predicate } from "../../../contracts/src/workflow-node.ts";
import type { BindingScope } from "./bindings.ts";

export function evaluate(pred: Predicate, bindings: BindingScope): boolean {
  switch (pred.op) {
    case "eq": {
      const left = bindings.resolveRef(pred.left);
      // No `right` ⇒ "left is truthy"; otherwise compare, resolving a `{{ … }}`
      // right-hand ref against bindings, else taking it as a literal.
      if (!("right" in pred) || pred.right === undefined) return isTruthy(left);
      const right = typeof pred.right === "string" && pred.right.includes("{{")
        ? bindings.resolveRef(pred.right)
        : pred.right;
      return left === right;
    }
    case "exists": {
      const v = bindings.resolveRef(pred.ref);
      return v !== undefined && v !== null;
    }
    case "and":
      return pred.clauses.every((c) => evaluate(c, bindings));
    case "or":
      return pred.clauses.some((c) => evaluate(c, bindings));
  }
}

function isTruthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== "" && v !== 0;
}
