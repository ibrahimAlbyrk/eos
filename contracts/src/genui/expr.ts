// Safe evaluators for visual answers. Dependency-free (the UI imports it directly);
// no eval, no Function, no prototype access.
//
// Expressions (<Value expr>, <Progress expr>, when=, {…} templates):
//   numbers, 'strings', true/false/null, + - * / %, < <= > >= == !=, && || !, ?:,
//   ( ), member access a.b and a[0]. Identifiers resolve to the current item's
//   fields, then state keys, then data; the roots item / state / data name each
//   scope. A member of a list maps over it (places.rating → every rating). Calls
//   only to: sum count min max avg round abs floor ceil fv(payment, annualRate, years).
//
// Filters (where=, <Filters chips>): clauses joined with && and || (&& binds
// tighter), grouped with ( ) and negated with !( ), each one of
//   open · field · !field · field op value   (op: == != < <= > >= ~)
// `~` is a case-insensitive contains (a list contains when any element does); the
// value may be a number, 'quoted' or bare text, true/false/null, or state.key, and
// state.key may stand in for the field too.

export type ExprValue = number | string | boolean | null | ExprValue[] | { [k: string]: unknown };

export interface ExprScope {
  item?: unknown;
  state?: unknown;
  data?: unknown;
}

export type ExprAst =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "lit"; v: boolean | null }
  | { t: "id"; name: string }
  | { t: "member"; obj: ExprAst; prop: string }
  | { t: "index"; obj: ExprAst; index: ExprAst }
  | { t: "un"; op: "!" | "-" | "+"; a: ExprAst }
  | { t: "bin"; op: BinOp; a: ExprAst; b: ExprAst }
  | { t: "cond"; c: ExprAst; a: ExprAst; b: ExprAst }
  | { t: "call"; fn: ExprFunction; args: ExprAst[] };

type BinOp = "+" | "-" | "*" | "/" | "%" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

export type ExprParseResult = { ok: true; ast: ExprAst } | { ok: false; error: string; at: number };

export const EXPR_FUNCTIONS = ["sum", "count", "min", "max", "avg", "round", "abs", "floor", "ceil", "fv"] as const;
export type ExprFunction = (typeof EXPR_FUNCTIONS)[number];
export const EXPR_ROOTS = ["item", "state", "data"] as const;
export const EXPR_MAX_LENGTH = 500;

const FUNCTION_SET: ReadonlySet<string> = new Set(EXPR_FUNCTIONS);
const ROOT_SET: ReadonlySet<string> = new Set(EXPR_ROOTS);
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PARSE_DEPTH = 40;
const IDENT_START = /[\p{L}_$]/u;
const IDENT_CHAR = /[\p{L}\p{N}_$]/u;

// ---- tokenizer ---------------------------------------------------------------

type Tok =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "id"; v: string; at: number }
  | { k: "op"; v: string; at: number }
  | { k: "end"; at: number };

const OPS = ["===", "!==", "&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", ",", ".", "[", "]", "?", ":"];

function tokenize(src: string): Tok[] | { error: string; at: number } {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) return { error: `bad number at ${i + 1}`, at: i };
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      let v = "";
      let k = i + 1;
      for (; k < src.length && src[k] !== c; k++) {
        if (src[k] === "\\" && k + 1 < src.length) {
          const e = src[++k];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else v += src[k];
      }
      if (k >= src.length) return { error: `string starting at ${i + 1} is never closed`, at: i };
      out.push({ k: "str", v, at: i });
      i = k + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let k = i + 1;
      while (k < src.length && IDENT_CHAR.test(src[k])) k++;
      out.push({ k: "id", v: src.slice(i, k), at: i });
      i = k;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return { error: `unexpected "${c}" at ${i + 1}`, at: i };
    out.push({ k: "op", v: op === "===" ? "==" : op === "!==" ? "!=" : op, at: i });
    i += op.length;
  }
  out.push({ k: "end", at: src.length });
  return out;
}

// ---- parser (precedence climbing) ----------------------------------------------

const BINARY_PREC: Record<string, number> = {
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

class ParseError extends Error {
  at: number;
  constructor(message: string, at: number) {
    super(message);
    this.at = at;
  }
}

export function parseExpr(src: unknown): ExprParseResult {
  if (typeof src !== "string") return { ok: false, error: "expression must be a string", at: 0 };
  if (!src.trim()) return { ok: false, error: "expression is empty", at: 0 };
  if (src.length > EXPR_MAX_LENGTH) return { ok: false, error: `expression is ${src.length} chars, max ${EXPR_MAX_LENGTH}`, at: 0 };
  const toks = tokenize(src);
  if (!Array.isArray(toks)) return { ok: false, error: toks.error, at: toks.at };
  let p = 0;
  const peek = (): Tok => toks[p];
  const isOp = (v: string): boolean => {
    const t = toks[p];
    return t.k === "op" && t.v === v;
  };
  const expectOp = (v: string): void => {
    if (!isOp(v)) throw new ParseError(`expected "${v}" at ${toks[p].at + 1}`, toks[p].at);
    p++;
  };

  const parseTernary = (depth: number): ExprAst => {
    if (depth > MAX_PARSE_DEPTH) throw new ParseError("expression is nested too deeply", peek().at);
    const c = parseBinary(0, depth);
    if (isOp("?")) {
      p++;
      const a = parseTernary(depth + 1);
      expectOp(":");
      const b = parseTernary(depth + 1);
      return { t: "cond", c, a, b };
    }
    return c;
  };

  const parseBinary = (minPrec: number, depth: number): ExprAst => {
    let left = parseUnary(depth + 1);
    for (;;) {
      const t = peek();
      if (t.k !== "op") break;
      const prec = BINARY_PREC[t.v];
      if (prec === undefined || prec <= minPrec) break;
      p++;
      const right = parseBinary(prec, depth + 1);
      left = { t: "bin", op: t.v as BinOp, a: left, b: right };
    }
    return left;
  };

  const parseUnary = (depth: number): ExprAst => {
    if (depth > MAX_PARSE_DEPTH) throw new ParseError("expression is nested too deeply", peek().at);
    const t = peek();
    if (t.k === "op" && (t.v === "!" || t.v === "-" || t.v === "+")) {
      p++;
      return { t: "un", op: t.v, a: parseUnary(depth + 1) };
    }
    return parsePostfix(parsePrimary(depth), depth);
  };

  const parsePrimary = (depth: number): ExprAst => {
    const t = peek();
    if (t.k === "num") {
      p++;
      return { t: "num", v: t.v };
    }
    if (t.k === "str") {
      p++;
      return { t: "str", v: t.v };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true" };
      if (t.v === "null") return { t: "lit", v: null };
      if (isOp("(")) {
        if (!FUNCTION_SET.has(t.v)) {
          throw new ParseError(`unknown function ${t.v}() — allowed: ${EXPR_FUNCTIONS.join(", ")}`, t.at);
        }
        p++;
        const args: ExprAst[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(parseTernary(depth + 1));
            if (isOp(",")) {
              p++;
              continue;
            }
            break;
          }
        }
        expectOp(")");
        return { t: "call", fn: t.v as ExprFunction, args };
      }
      if (FORBIDDEN_KEYS.has(t.v)) throw new ParseError(`"${t.v}" is not allowed`, t.at);
      return { t: "id", name: t.v };
    }
    if (t.k === "op" && t.v === "(") {
      p++;
      const inner = parseTernary(depth + 1);
      expectOp(")");
      return inner;
    }
    if (t.k === "end") throw new ParseError("expression ends too early", t.at);
    throw new ParseError(`unexpected "${t.k === "op" ? t.v : ""}" at ${t.at + 1}`, t.at);
  };

  const parsePostfix = (base: ExprAst, depth: number): ExprAst => {
    let node = base;
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t.k !== "id") throw new ParseError(`expected a field name after "." at ${t.at + 1}`, t.at);
        if (FORBIDDEN_KEYS.has(t.v)) throw new ParseError(`"${t.v}" is not allowed`, t.at);
        p++;
        if (isOp("(")) throw new ParseError(`only ${EXPR_FUNCTIONS.join(", ")} can be called`, t.at);
        node = { t: "member", obj: node, prop: t.v };
        continue;
      }
      if (isOp("[")) {
        p++;
        const index = parseTernary(depth + 1);
        expectOp("]");
        node = { t: "index", obj: node, index };
        continue;
      }
      if (isOp("(")) throw new ParseError(`only ${EXPR_FUNCTIONS.join(", ")} can be called`, peek().at);
      return node;
    }
  };

  try {
    const ast = parseTernary(0);
    const t = peek();
    if (t.k !== "end") throw new ParseError(`unexpected "${t.k === "op" || t.k === "id" ? t.v : "value"}" at ${t.at + 1}`, t.at);
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, at: e.at };
    return { ok: false, error: e instanceof Error ? e.message : String(e), at: 0 };
  }
}

// null when valid, else the reason.
export function checkExpr(src: unknown): string | null {
  const r = parseExpr(src);
  return r.ok ? null : r.error;
}

// The names an expression reads: bare identifiers ("save") and scoped ones
// ("state.save", "data.places", "item.name"). Function names are not included.
export function exprRefs(src: unknown): string[] {
  const r = parseExpr(src);
  if (!r.ok) return [];
  const out = new Set<string>();
  const visit = (n: ExprAst): void => {
    switch (n.t) {
      case "id":
        if (!ROOT_SET.has(n.name)) out.add(n.name);
        return;
      case "member":
        if (n.obj.t === "id" && ROOT_SET.has(n.obj.name)) out.add(`${n.obj.name}.${n.prop}`);
        else visit(n.obj);
        return;
      case "index":
        visit(n.obj);
        visit(n.index);
        return;
      case "un":
        visit(n.a);
        return;
      case "bin":
        visit(n.a);
        visit(n.b);
        return;
      case "cond":
        visit(n.c);
        visit(n.a);
        visit(n.b);
        return;
      case "call":
        n.args.forEach(visit);
        return;
      default:
        return;
    }
  };
  visit(r.ast);
  return [...out];
}

// ---- evaluator -----------------------------------------------------------------

const cache = new Map<string, ExprParseResult>();
const CACHE_MAX = 500;

function cachedParse(src: string): ExprParseResult {
  let r = cache.get(src);
  if (!r) {
    r = parseExpr(src);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(src, r);
  }
  return r;
}

// The value of an expression, or null when it doesn't parse or can't be computed.
export function evalExpr(src: unknown, scope: ExprScope = {}): ExprValue {
  if (typeof src !== "string") return null;
  const r = cachedParse(src);
  return r.ok ? evalAst(r.ast, scope) : null;
}

export function evalAst(ast: ExprAst, scope: ExprScope = {}): ExprValue {
  try {
    return norm(ev(ast, scope));
  } catch {
    return null;
  }
}

function ev(n: ExprAst, scope: ExprScope): unknown {
  switch (n.t) {
    case "num":
    case "str":
    case "lit":
      return n.v;
    case "id":
      return resolveName(n.name, scope);
    case "member":
      return member(ev(n.obj, scope), n.prop);
    case "index": {
      const key = ev(n.index, scope);
      const obj = ev(n.obj, scope);
      if (Array.isArray(obj) && typeof key === "number") return obj[Math.trunc(key) < 0 ? obj.length + Math.trunc(key) : Math.trunc(key)];
      if (typeof key === "string" || typeof key === "number") return member(obj, String(key));
      return null;
    }
    case "un": {
      const a = ev(n.a, scope);
      if (n.op === "!") return !truthy(a);
      const x = toNum(a);
      if (x == null) return null;
      return n.op === "-" ? -x : x;
    }
    case "bin":
      return binary(n.op, n.a, n.b, scope);
    case "cond":
      return truthy(ev(n.c, scope)) ? ev(n.a, scope) : ev(n.b, scope);
    case "call":
      return call(n.fn, n.args.map((a) => ev(a, scope)));
    default:
      return null;
  }
}

function own(obj: unknown, key: string): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

function resolveName(name: string, scope: ExprScope): unknown {
  if (name === "item") return scope.item ?? null;
  if (name === "state") return scope.state ?? null;
  if (name === "data") return scope.data ?? null;
  for (const src of [scope.item, scope.state, scope.data]) {
    const v = own(src, name);
    if (v !== undefined) return v;
  }
  return null;
}

function member(obj: unknown, prop: string): unknown {
  if (Array.isArray(obj)) return obj.map((el) => member(el, prop));
  const v = own(obj, prop);
  return v === undefined ? null : v;
}

function binary(op: BinOp, an: ExprAst, bn: ExprAst, scope: ExprScope): unknown {
  if (op === "&&") {
    const a = ev(an, scope);
    return truthy(a) ? ev(bn, scope) : a;
  }
  if (op === "||") {
    const a = ev(an, scope);
    return truthy(a) ? a : ev(bn, scope);
  }
  const a = ev(an, scope);
  const b = ev(bn, scope);
  switch (op) {
    case "==":
      return looseEq(a, b);
    case "!=":
      return !looseEq(a, b);
    case "<":
    case "<=":
    case ">":
    case ">=":
      return compare(op, a, b);
    case "+": {
      const x = toNum(a);
      const y = toNum(b);
      if (x != null && y != null) return x + y;
      if (typeof a === "string" || typeof b === "string") return `${str(a)}${str(b)}`;
      return null;
    }
    default: {
      const x = toNum(a);
      const y = toNum(b);
      if (x == null || y == null) return null;
      if (op === "-") return x - y;
      if (op === "*") return x * y;
      if (op === "/") return y === 0 ? null : x / y;
      return y === 0 ? null : x % y;
    }
  }
}

function call(fn: ExprFunction, args: unknown[]): unknown {
  switch (fn) {
    case "sum":
      return nums(args).reduce((s, x) => s + x, 0);
    case "min": {
      const xs = nums(args);
      return xs.length ? Math.min(...xs) : null;
    }
    case "max": {
      const xs = nums(args);
      return xs.length ? Math.max(...xs) : null;
    }
    case "avg": {
      const xs = nums(args);
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    }
    case "count": {
      let n = 0;
      const visit = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v != null && v !== false && v !== "") n++;
      };
      args.forEach(visit);
      return n;
    }
    case "round": {
      const x = toNum(args[0]);
      if (x == null) return null;
      const d = Math.max(0, Math.min(10, Math.trunc(toNum(args[1]) ?? 0)));
      const f = 10 ** d;
      return Math.round(x * f) / f;
    }
    case "abs":
    case "floor":
    case "ceil": {
      const x = toNum(args[0]);
      return x == null ? null : Math[fn](x);
    }
    case "fv": {
      // Monthly contributions compounded monthly — "save P a month at R for Y years".
      const pay = toNum(args[0]);
      const rate = toNum(args[1]);
      const years = toNum(args[2]);
      if (pay == null || rate == null || years == null) return null;
      const r = rate / 12;
      const months = Math.round(years * 12);
      if (months <= 0) return 0;
      return r === 0 ? pay * months : pay * (((1 + r) ** months - 1) / r);
    }
    default:
      return null;
  }
}

function nums(args: unknown[]): number[] {
  const out: number[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else {
      const x = typeof v === "boolean" ? null : toNum(v);
      if (x != null) out.push(x);
    }
  };
  args.forEach(visit);
  return out;
}

const NUMERIC = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && NUMERIC.test(v)) return Number(v);
  return null;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  return v != null && v !== false && v !== "";
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") {
    const x = toNum(a);
    const y = toNum(b);
    return x != null && y != null && x === y;
  }
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return false;
}

function compare(op: "<" | "<=" | ">" | ">=", a: unknown, b: unknown): boolean {
  const x = toNum(a);
  const y = toNum(b);
  let c: number;
  if (x != null && y != null && typeof a !== "boolean" && typeof b !== "boolean") c = x - y;
  else if (typeof a === "string" && typeof b === "string") c = a < b ? -1 : a > b ? 1 : 0;
  else return false;
  if (op === "<") return c < 0;
  if (op === "<=") return c <= 0;
  if (op === ">") return c > 0;
  return c >= 0;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).join(", ");
  return "";
}

function norm(v: unknown): ExprValue {
  if (v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") return v as { [k: string]: unknown };
  return null;
}

// ---- templates ----------------------------------------------------------------

export interface TemplateOptions {
  // How plain numbers print (the UI passes Intl formatting); default String(n).
  formatNumber?: (n: number) => string;
}

// A string that holds at least one {…} template.
export const TEMPLATE_RE = /\{[^{}]*[^{}\s][^{}]*\}/;

export function hasTemplate(v: unknown): boolean {
  return typeof v === "string" && TEMPLATE_RE.test(v);
}

// Fills `{expr}` holes ("{name}", "{state.party}", "{price * 2}") from the scope.
// A hole that resolves to nothing prints as ""; text in braces that isn't an
// expression stays as written; `{{` and `}}` print literal braces.
export function fillTemplate(template: unknown, scope: ExprScope = {}, opts: TemplateOptions = {}): string {
  if (typeof template !== "string") return template == null ? "" : String(template);
  if (template.indexOf("{") < 0 && template.indexOf("}}") < 0) return template;
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === "{" && template[i + 1] === "{") {
      out += "{";
      i += 2;
      continue;
    }
    if (c === "}" && template[i + 1] === "}") {
      out += "}";
      i += 2;
      continue;
    }
    if (c === "{") {
      const close = template.indexOf("}", i + 1);
      const inner = close < 0 ? "" : template.slice(i + 1, close);
      if (close < 0 || inner.includes("{")) {
        out += c;
        i++;
        continue;
      }
      const r = cachedParse(inner.trim());
      if (!r.ok) {
        out += template.slice(i, close + 1);
      } else {
        out += printValue(evalAst(r.ast, scope), opts);
      }
      i = close + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function printValue(v: ExprValue, opts: TemplateOptions): string {
  if (v == null) return "";
  if (typeof v === "number") return opts.formatNumber ? opts.formatNumber(v) : String(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // Coordinates and other number lists print compactly ("40.98,29.02").
    if (v.every((x) => typeof x === "number")) return v.join(",");
    return v.map((x) => printValue(x, opts)).filter(Boolean).join(", ");
  }
  const named = own(v, "name") ?? own(v, "title");
  return typeof named === "string" ? named : "";
}

// ---- filters -------------------------------------------------------------------

export type WhereOp = "open" | "truthy" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "~";

export interface WhereClause {
  op: WhereOp;
  // Dotted field path; absent for `open` and when the left side is state.
  field?: string;
  // `state.key` on the left-hand side: that state value is tested, not a field.
  lref?: string;
  not?: boolean;
  value?: string | number | boolean | null;
  // `state.key` on the right-hand side: compared against that state value.
  ref?: string;
}

// `a && b` (and), `a || b` (or); `!( … )` sets not.
export interface WhereGroup {
  op: "and" | "or";
  of: WhereNode[];
  not?: boolean;
}

export type WhereNode = WhereClause | WhereGroup;

export type WhereParseResult = { ok: true; node: WhereNode } | { ok: false; error: string };

const FIELD = "[\\p{L}_$][\\p{L}\\p{N}_$]*(?:\\.[\\p{L}_$][\\p{L}\\p{N}_$]*)*";
const CLAUSE_RE = new RegExp(`^(${FIELD})\\s*(===|!==|==|!=|<=|>=|=|<|>|~)\\s*(.*)$`, "u");
const FLAG_RE = new RegExp(`^(!?)\\s*(${FIELD})$`, "u");
const NOT_GROUP_RE = /!\s*\(/y;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const WHERE_HINT = "use open, field, !field or field op value (op: == != < <= > >= ~), joined with && or ||, grouped with ( )";

export function parseWhere(src: unknown): WhereParseResult {
  if (typeof src !== "string") return { ok: false, error: "filter must be a string" };
  if (!src.trim()) return { ok: false, error: "filter is empty" };
  if (src.length > EXPR_MAX_LENGTH) return { ok: false, error: `filter is ${src.length} chars, max ${EXPR_MAX_LENGTH}` };
  try {
    return { ok: true, node: parseWhereNode(src) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// or := and ('||' and)* · and := unary ('&&' unary)* · unary := '!'? '(' or ')' | clause.
// A clause runs to the next && / || or group-closing ")" outside quotes, so bare
// values read as they always did ("hours.until > 20:00", "name == Kebap (Moda)").
function parseWhereNode(src: string): WhereNode {
  let i = 0;
  let groups = 0;
  const skipWs = (): void => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  // A string ends at its quote mark followed by a space, &, |, ) or the end.
  const closingQuote = (q: string, from: number): number => {
    for (let k = src.indexOf(q, from); k > 0; k = src.indexOf(q, k + 1)) {
      if (k + 1 >= src.length || /[\s&|)]/.test(src[k + 1])) return k;
    }
    return -1;
  };
  const unexpected = (k: number): string =>
    src[k] === ")" ? `")" at ${k + 1} has no "("` : `expected && or || before "${src.slice(k, k + 16).trim()}" at ${k + 1} — ${WHERE_HINT}`;

  const parseChain = (op: "and" | "or", depth: number): WhereNode => {
    const sep = op === "or" ? "||" : "&&";
    const next = (): WhereNode => (op === "or" ? parseChain("and", depth) : parseUnary(depth));
    const of = [next()];
    for (skipWs(); src.startsWith(sep, i); skipWs()) {
      i += sep.length;
      of.push(next());
    }
    return of.length === 1 ? of[0] : { op, of };
  };

  const parseUnary = (depth: number): WhereNode => {
    if (depth > MAX_PARSE_DEPTH) throw new ParseError("filter is nested too deeply", i);
    skipWs();
    NOT_GROUP_RE.lastIndex = i;
    if (NOT_GROUP_RE.test(src)) {
      i++;
      return negate(parseUnary(depth + 1));
    }
    if (src[i] !== "(") return parseClauseAt();
    const start = i++;
    groups++;
    const inner = parseChain("or", depth + 1);
    skipWs();
    if (src[i] !== ")") throw new ParseError(i < src.length ? unexpected(i) : `"(" at ${start + 1} is never closed`, i);
    i++;
    groups--;
    return inner;
  };

  const parseClauseAt = (): WhereClause => {
    const start = i;
    let parens = 0;
    while (i < src.length) {
      const c = src[i];
      // A quote opens a string only at a word boundary (O'Brien stays text) and only when it closes.
      if ((c === "'" || c === '"') && !WORD_CHAR.test(src[i - 1] ?? "")) {
        const close = closingQuote(c, i + 1);
        if (close > 0) {
          i = close + 1;
          continue;
        }
      }
      if (src.startsWith("&&", i) || src.startsWith("||", i)) break;
      if (c === "(") parens++;
      else if (c === ")") {
        if (parens > 0) parens--;
        else if (groups > 0) break;
      }
      i++;
    }
    const part = src.slice(start, i).trim();
    if (!part) throw new ParseError(`empty clause in "${src}" — ${WHERE_HINT}`, start);
    return parseClause(part);
  };

  const node = parseChain("or", 0);
  skipWs();
  if (i < src.length) throw new ParseError(unexpected(i), i);
  return node;
}

function parseClause(part: string): WhereClause {
  if (part === "open" || part === "!open") return part === "open" ? { op: "open" } : { op: "open", not: true };
  const m = CLAUSE_RE.exec(part);
  if (m) {
    const opRaw = m[2];
    const op: WhereOp = opRaw === "=" || opRaw === "===" ? "==" : opRaw === "!==" ? "!=" : (opRaw as WhereOp);
    const rhs = m[3].trim();
    if (!rhs) throw new ParseError(`"${part}" has no value after ${opRaw}`, 0);
    if (/^[=<>!~]/.test(rhs)) throw new ParseError(`"${part}" has two operators — ${WHERE_HINT}`, 0);
    const ref = /^\{?\s*state\.([\p{L}_$][\p{L}\p{N}_$]*)\s*\}?$/u.exec(rhs);
    if (ref) return { op, ...leftSide(m[1]), ref: ref[1] };
    return { op, ...leftSide(m[1]), value: literal(rhs) };
  }
  const f = FLAG_RE.exec(part);
  if (f) return f[1] ? { op: "truthy", ...leftSide(f[2]), not: true } : { op: "truthy", ...leftSide(f[2]) };
  throw new ParseError(`"${part}" is not a filter — ${WHERE_HINT}`, 0);
}

function leftSide(field: string): { field: string } | { lref: string } {
  return field.startsWith("state.") ? { lref: field.slice("state.".length) } : { field };
}

function negate(n: WhereNode): WhereNode {
  const out = { ...n };
  if (out.not) delete out.not;
  else out.not = true;
  return out;
}

// Whether a filter reads view state (state.key on either side of any clause).
export function whereReadsState(n: WhereNode): boolean {
  if ("of" in n) return n.of.some(whereReadsState);
  return n.ref !== undefined || n.lref !== undefined;
}

export function checkWhere(src: unknown): string | null {
  const r = parseWhere(src);
  return r.ok ? null : r.error;
}

function literal(rhs: string): string | number | boolean | null {
  const q = /^(['"])(.*)\1$/s.exec(rhs);
  if (q) return q[2];
  if (NUMERIC.test(rhs)) return Number(rhs);
  if (rhs === "true") return true;
  if (rhs === "false") return false;
  if (rhs === "null") return null;
  return rhs;
}

const whereCache = new Map<string, WhereParseResult>();

// Whether an item passes a filter. A filter that doesn't parse filters nothing
// (the validator rejects it before it is ever stored).
export function matchWhere(item: unknown, where: string | WhereNode, state?: unknown): boolean {
  let node: WhereNode;
  if (typeof where === "string") {
    let r = whereCache.get(where);
    if (!r) {
      r = parseWhere(where);
      if (whereCache.size >= CACHE_MAX) whereCache.clear();
      whereCache.set(where, r);
    }
    if (!r.ok) return true;
    node = r.node;
  } else node = where;
  return matchNode(item, node, state);
}

function matchNode(item: unknown, n: WhereNode, state: unknown): boolean {
  let r: boolean;
  if (!("of" in n)) r = matchClause(item, n, state);
  else if (n.op === "and") r = n.of.every((c) => matchNode(item, c, state));
  else r = n.of.some((c) => matchNode(item, c, state));
  return n.not ? !r : r;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    cur = own(cur, k);
    if (cur === undefined) return undefined;
  }
  return cur;
}

function lower(v: unknown): string {
  return str(v).toLocaleLowerCase();
}

// The clause's own test; matchNode applies `not`.
function matchClause(item: unknown, c: WhereClause, state: unknown): boolean {
  if (c.op === "open") {
    const hours = own(item, "hours");
    const closedByHours = own(hours, "closed") === true;
    return !closedByHours && lower(own(item, "status")) !== "closed";
  }
  const v = c.lref !== undefined ? getPath(state, c.lref) : getPath(item, c.field ?? "");
  if (c.op === "truthy") return truthy(v);
  const want = c.ref !== undefined ? (own(state, c.ref) as ExprValue | undefined) ?? null : c.value ?? null;
  return compareField(c.op, v, want);
}

function compareField(op: WhereOp, v: unknown, want: unknown): boolean {
  if (op === "~") {
    const needle = lower(want);
    if (Array.isArray(v)) return v.some((el) => lower(el).includes(needle));
    if (v == null || typeof v === "object") return false;
    return lower(v).includes(needle);
  }
  if (op === "==" || op === "!=") {
    const eq = Array.isArray(v) ? v.some((el) => fieldEq(el, want)) : fieldEq(v, want);
    return op === "==" ? eq : !eq;
  }
  if (v == null || Array.isArray(v) || typeof v === "object") return false;
  return compare(op as "<" | "<=" | ">" | ">=", v, want);
}

// Filters compare text case-insensitively and numbers as numbers.
function fieldEq(v: unknown, want: unknown): boolean {
  if (v === undefined) v = null;
  if (v == null || want == null) return v == null && want == null;
  const x = toNum(v);
  const y = toNum(want);
  if (x != null && y != null && typeof v !== "boolean" && typeof want !== "boolean") return x === y;
  if (typeof v === "boolean" || typeof want === "boolean") return String(v) === String(want);
  return lower(v) === lower(want);
}
