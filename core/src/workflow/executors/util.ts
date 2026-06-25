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

// extractJson — Tolerant Reader (§3.6): recover a JSON value from a step's
// free-form final report. Tries the first fenced ```json block, then the first
// balanced {...}/[...] span; returns `found:false` when neither parses, so the
// caller fails the step loudly instead of binding prose. Pure: no Node imports
// and no nondeterministic time/random (JSON is a plain built-in, as in keyOf).
export function extractJson(text: string): { value: unknown; found: boolean } {
  for (const candidate of [fencedJson(text), balancedSpan(text)]) {
    if (candidate == null) continue;
    try {
      return { value: JSON.parse(candidate), found: true };
    } catch {
      // not parseable — fall through to the next candidate
    }
  }
  return { value: undefined, found: false };
}

function fencedJson(text: string): string | null {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return m ? m[1].trim() : null;
}

// Scan for the first balanced object/array literal, honoring string quoting so a
// `}` or `]` inside a string never closes the span early.
function balancedSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
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
