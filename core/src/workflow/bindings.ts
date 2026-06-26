// BindingScope — the run-scoped data-flow map (§3.3). Every node's output lands
// here under its stable `id`; downstream prompts/refs read it back. Data flow is
// explicit named bindings, never a shared blackboard: a prompt references
// `{{args.*}}` (the run args) or `{{nodes.<id>.output[.sub]}}` (a prior node's
// output), and fan-out is aggregated by the glob `{{nodes.<prefix>-*.output}}`
// which collects every matching node's output into a list (§5.2). Pure: no Node,
// no Date.now/Math.random.

// The {{ … }} token — looser than the prompt template's path grammar because a
// binding path carries `-` (node-id slugs like `research-0`) and `*` (the
// fan-out glob), neither allowed by the DPI template engine.
const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

export class BindingScope {
  private readonly args: unknown;
  private readonly outputs: Map<string, unknown>;

  constructor(args?: unknown) {
    this.args = args;
    this.outputs = new Map();
  }

  set(id: string, output: unknown): void {
    this.outputs.set(id, output);
  }

  get(id: string): unknown {
    return this.outputs.get(id);
  }

  has(id: string): boolean {
    return this.outputs.has(id);
  }

  // Resolve a single reference to its raw VALUE (used by `over` refs + predicate
  // operands). Accepts either a `{{ … }}`-wrapped ref or a bare path.
  resolveRef(ref: string, locals?: Record<string, unknown>): unknown {
    const path = ref.trim().replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
    return this.resolvePath(path, locals);
  }

  // Resolve EVERY `{{ … }}` token in a template to its stringified value (used to
  // build a step's prompt before the executor spawns its worker).
  resolve(template: string, locals?: Record<string, unknown>): string {
    return template.replace(TOKEN, (_match, inner: string) => stringifyBinding(this.resolvePath(inner.trim(), locals)));
  }

  // Like `resolve`, but reports every `{{nodes.*}}` token that resolved to
  // `undefined` (a wrong path, a missing field, or a node that never produced
  // output) instead of silently rendering "". `args.*` and injected locals stay
  // tolerant (undefined → ""); only a dangling reference to a prior node's output
  // is a hard authoring error, which the step executor surfaces by failing the
  // step rather than feeding it empty input.
  resolveStrict(template: string, locals?: Record<string, unknown>): { text: string; unresolved: string[] } {
    const unresolved: string[] = [];
    const text = template.replace(TOKEN, (_match, inner: string) => {
      const path = inner.trim();
      const value = this.resolvePath(path, locals);
      if (value === undefined && path.split(".")[0] === "nodes") unresolved.push(path);
      return stringifyBinding(value);
    });
    return { text, unresolved };
  }

  private resolvePath(path: string, locals?: Record<string, unknown>): unknown {
    if (path === "") return undefined;
    const parts = path.split(".");
    const root = parts[0];
    if (root === "args") return walkPath(this.args, parts.slice(1));
    if (root === "nodes") return this.resolveNodes(parts.slice(1));
    if (locals && Object.hasOwn(locals, root)) return walkPath(locals[root], parts.slice(1));
    return undefined;
  }

  // `nodes.<id>.output[.sub…]` — `<id>` may carry a `*` glob, in which case every
  // bound id matching the pattern contributes its output to an aggregate list.
  private resolveNodes(parts: string[]): unknown {
    if (parts.length === 0) return undefined;
    const id = parts[0];
    const rest = parts[1] === "output" ? parts.slice(2) : parts.slice(1);
    if (id.includes("*")) {
      const re = globToRegExp(id);
      const matched: unknown[] = [];
      for (const [boundId, output] of this.outputs) {
        if (re.test(boundId)) matched.push(rest.length ? walkPath(output, rest) : output);
      }
      return matched;
    }
    const output = this.outputs.get(id);
    return rest.length ? walkPath(output, rest) : output;
  }
}

function walkPath(value: unknown, parts: string[]): unknown {
  let cur = value;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

function stringifyBinding(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
