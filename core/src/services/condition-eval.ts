// Evaluate a DPI condition tree against the FactSet — the Specification pattern
// realized as data, interpreted here. Leaf form names one fact + one operator;
// the first operator present wins. A bare leaf (just `fact`) means "is truthy".
// The operator set is closed on purpose (see contracts/src/prompt.ts).

import type { Condition, ConditionLeaf } from "../../../contracts/src/prompt.ts";

export function evaluateCondition(cond: Condition, facts: Record<string, unknown>): boolean {
  if ("all" in cond) return cond.all.every((c) => evaluateCondition(c, facts));
  if ("any" in cond) return cond.any.some((c) => evaluateCondition(c, facts));
  if ("not" in cond) return !evaluateCondition(cond.not, facts);
  return evaluateLeaf(cond as ConditionLeaf, facts);
}

function evaluateLeaf(leaf: ConditionLeaf, facts: Record<string, unknown>): boolean {
  const v = facts[leaf.fact];
  if (leaf.eq !== undefined) return v === leaf.eq;
  if (leaf.ne !== undefined) return v !== leaf.ne;
  if (leaf.in !== undefined) return leaf.in.includes(v);
  if (leaf.nin !== undefined) return !leaf.nin.includes(v);
  if (leaf.exists !== undefined) return (v !== undefined && v !== null) === leaf.exists;
  if (leaf.truthy !== undefined) return truthy(v) === leaf.truthy;
  return truthy(v);
}

function truthy(v: unknown): boolean {
  if (v == null || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
