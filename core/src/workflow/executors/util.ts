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
