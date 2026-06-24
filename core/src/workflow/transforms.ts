// transforms.ts — the TransformFnRegistry: name → pure function, the Open/Closed
// seam for the deterministic glue/transform nodes (§3.2). The IR never carries
// inline code; a glue node names a registered fn (`fn`) over a bound input
// (`over`), and the executor looks the fn up here. Cloning the executor registry
// shape: register explicitly, `get` throws an enumerated error on an unknown name.
// Seeded with sensible built-ins; the composition root may register more the same
// Open/Closed way. Pure: no Node, no Date.now/Math.random.

// A glue fn is intentionally variadic so one registry serves every node kind:
//   map/transform/filter → fn(item) ;  dedup/tally → fn(item)=key ;
//   accumulate           → fn(acc, item)=acc.
export type TransformFn = (..._args: unknown[]) => unknown;

export class TransformFnRegistry {
  private readonly fns: Map<string, TransformFn>;

  constructor() {
    this.fns = new Map();
  }

  register(name: string, fn: TransformFn): void {
    this.fns.set(name, fn);
  }

  get(name: string): TransformFn {
    const fn = this.fns.get(name);
    if (!fn) {
      const known = this.fns.size ? [...this.fns.keys()].join(", ") : "none";
      throw new Error(`no transform fn "${name}" (registered: ${known})`);
    }
    return fn;
  }

  has(name: string): boolean {
    return this.fns.has(name);
  }

  names(): string[] {
    return [...this.fns.keys()];
  }
}

function asList(x: unknown): unknown[] {
  return Array.isArray(x) ? x : x == null ? [] : [x];
}

// The built-in fns cover the §3.2 worked patterns (set-difference dedup,
// majority-vote tally, fold-accumulate) plus the common list shapings.
export function defaultTransformFnRegistry(): TransformFnRegistry {
  const r = new TransformFnRegistry();

  // identity — the default key extractor for dedup/tally; also a no-op map.
  r.register("identity", (x) => x);

  // filter predicates (filter keeps items where fn(item) is truthy).
  r.register("isTruthy", (x) => Boolean(x));
  r.register("isDefined", (x) => x != null);

  // whole-value transforms (the `over` value, not per-item).
  r.register("flatten", (xs) => asList(xs).flat());
  r.register("compact", (xs) => asList(xs).filter((v) => v != null));
  r.register("unique", (xs) => [...new Set(asList(xs))]);
  r.register("length", (xs) => asList(xs).length);

  // accumulate reducers: (acc, item) → acc.
  r.register("concat", (acc, item) => [...asList(acc), item]);
  r.register("sum", (acc, item) => (typeof acc === "number" ? acc : 0) + Number(item));
  r.register("count", (acc) => (typeof acc === "number" ? acc : 0) + 1);

  return r;
}
