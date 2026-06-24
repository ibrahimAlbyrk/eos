// glue.ts — the deterministic transform nodes (§3.2). Each resolves its `over`
// input from the run bindings and applies a PURE function named by `fn`, looked up
// in the injected TransformFnRegistry — the IR never carries inline code. These
// are the engine's in-process glue between fan-out and fan-in (set-difference
// dedup, majority-vote tally, fold-accumulate, list shaping). The executors are
// factories so the composition root injects one shared fn registry:
//   transform — apply fn to the whole `over` value
//   map       — apply fn per item
//   filter    — keep items where fn(item) is truthy
//   dedup     — first occurrence per key (fn = key extractor; omitted ⇒ identity)
//   tally     — count by key (fn = key; omitted ⇒ identity)
//   accumulate— fold (fn = reducer over `init`)

import type {
  TransformNode, MapNode, FilterNode, DedupNode, TallyNode, AccumulateNode,
} from "../../../../contracts/src/workflow-node.ts";
import type { StepExecutor } from "../../ports/StepExecutor.ts";
import type { TransformFnRegistry, TransformFn } from "../transforms.ts";
import { resolveList, execLocals, keyOf } from "./util.ts";

const identity: TransformFn = (x) => x;

export function makeTransformExecutor(fns: TransformFnRegistry): StepExecutor<TransformNode> {
  return {
    type: "transform",
    async execute(node, ctx) {
      const fn = fns.get(node.fn);
      const value = ctx.bindings.resolveRef(node.over, execLocals(ctx));
      return { output: fn(value), status: "passed" };
    },
  };
}

export function makeMapExecutor(fns: TransformFnRegistry): StepExecutor<MapNode> {
  return {
    type: "map",
    async execute(node, ctx) {
      const fn = fns.get(node.fn);
      return { output: resolveList(ctx, node.over).map((item) => fn(item)), status: "passed" };
    },
  };
}

export function makeFilterExecutor(fns: TransformFnRegistry): StepExecutor<FilterNode> {
  return {
    type: "filter",
    async execute(node, ctx) {
      const fn = fns.get(node.fn);
      return { output: resolveList(ctx, node.over).filter((item) => Boolean(fn(item))), status: "passed" };
    },
  };
}

export function makeDedupExecutor(fns: TransformFnRegistry): StepExecutor<DedupNode> {
  return {
    type: "dedup",
    async execute(node, ctx) {
      const keyFn = node.fn ? fns.get(node.fn) : identity;
      const seen = new Set<string>();
      const out: unknown[] = [];
      for (const item of resolveList(ctx, node.over)) {
        const k = keyOf(keyFn(item));
        if (!seen.has(k)) {
          seen.add(k);
          out.push(item);
        }
      }
      return { output: out, status: "passed" };
    },
  };
}

export function makeTallyExecutor(fns: TransformFnRegistry): StepExecutor<TallyNode> {
  return {
    type: "tally",
    async execute(node, ctx) {
      const keyFn = node.fn ? fns.get(node.fn) : identity;
      const counts: Record<string, number> = {};
      for (const item of resolveList(ctx, node.over)) {
        const k = keyOf(keyFn(item));
        counts[k] = (counts[k] ?? 0) + 1;
      }
      return { output: counts, status: "passed" };
    },
  };
}

export function makeAccumulateExecutor(fns: TransformFnRegistry): StepExecutor<AccumulateNode> {
  return {
    type: "accumulate",
    async execute(node, ctx) {
      const fn = fns.get(node.fn);
      const out = resolveList(ctx, node.over).reduce((acc, item) => fn(acc, item), node.init);
      return { output: out, status: "passed" };
    },
  };
}
