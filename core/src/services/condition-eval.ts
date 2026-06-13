// Evaluate a DPI condition tree against the FactSet — the Specification pattern
// realized as data, interpreted here. Leaf form names one fact + one operator;
// operator presence is detected by own-property (so `eq: null` / `eq: false` are
// matchable), first present wins. A bare leaf (just `fact`) means "is truthy".
// The operator set is closed on purpose (see contracts/src/prompt.ts).

import type { Condition, ConditionLeaf } from "../../../contracts/src/prompt.ts";
import { isTruthy } from "../domain/prompt.ts";

export function evaluateCondition(cond: Condition, facts: Record<string, unknown>): boolean {
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, facts));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, facts));
  if ("not" in cond) return !evaluateCondition(cond.not, facts);
  return evaluateLeaf(cond as ConditionLeaf, facts);
}

function evaluateLeaf(leaf: ConditionLeaf, facts: Record<string, unknown>): boolean {
  const v = facts[leaf.fact];
  if (Object.hasOwn(leaf, "eq")) return v === leaf.eq;
  if (Object.hasOwn(leaf, "ne")) return v !== leaf.ne;
  if (Object.hasOwn(leaf, "in")) return Array.isArray(leaf.in) && leaf.in.includes(v);
  if (Object.hasOwn(leaf, "nin")) return Array.isArray(leaf.nin) && !leaf.nin.includes(v);
  if (Object.hasOwn(leaf, "exists")) return (v !== undefined && v !== null) === leaf.exists;
  if (Object.hasOwn(leaf, "truthy")) return isTruthy(v) === leaf.truthy;
  return isTruthy(v);
}
