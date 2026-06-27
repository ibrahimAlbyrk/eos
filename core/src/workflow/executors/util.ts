// util.ts — small pure helpers shared across the executors. `execLocals` lifts the
// fan-out / loop metadata the engine injected into ctx (item/index/iteration/…)
// into the `locals` map BindingScope.resolve consumes, so a body prompt can read
// `{{item}}` / `{{iteration}}`. `resolveList` resolves an `over` ref to an array
// (the fan-out / glue source). Pure: no Node, no Date.now/Math.random.

import type { WorkflowExecCtx } from "../../ports/StepExecutor.ts";

export function execLocals(ctx: WorkflowExecCtx): Record<string, unknown> {
  const locals: Record<string, unknown> = {};
  if (ctx.item !== undefined) locals.item = ctx.item;
  if (ctx.index !== undefined) locals.index = ctx.index;
  if (ctx.iteration !== undefined) locals.iteration = ctx.iteration;
  if (ctx.lastResult !== undefined) locals.lastResult = ctx.lastResult;
  if (ctx.lastCount !== undefined) locals.lastCount = ctx.lastCount;
  // The node's resolved input ports (Phase 3 / A5): a prompt/`over` ref reads an
  // edge-delivered value as `{{in.<port>}}` — intra-node interpolation of the node's
  // OWN inputs, the surviving string-binding role, now fed by typed edges.
  if (ctx.inputs !== undefined) locals.in = ctx.inputs;
  return locals;
}

export function resolveList(ctx: WorkflowExecCtx, ref: string): unknown[] {
  const v = ctx.bindings.resolveRef(ref, execLocals(ctx));
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A coarse runtime kind for a value, used by the scheduler's port-type check to
// name what a mis-typed input actually was ("expected number, got string").
export function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Stable string key for dedup/tally grouping. Primitives stringify directly;
// objects fall back to JSON (best-effort, like BindingScope).
export function keyOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
