// Tolerant JSON readers for visual answers. Dependency-free: the UI imports this
// file directly (like attachments.ts) to render a `present` call while the model
// is still writing it.
//
// parsePartialJson(prefix) reads a growing prefix of a JSON document and returns
// only what is already settled:
//   - an object keeps its complete key/values, plus nested objects/arrays that are
//     still being written (recursively, under the same rules);
//   - an array keeps only complete elements, so data rows appear whole;
//   - a string still being written is dropped — except under the top-level keys in
//     `partialKeys` (default: "ui"), where the prefix is kept so markup streams;
//   - a number or literal at the very end is dropped (more digits may follow).
// parseLooseJson(text) reads one complete value and forgives what models often
// write in markup attributes: single quotes, unquoted keys, trailing commas, comments.

export interface PartialJsonOptions {
  // Top-level keys whose string value is kept while still incomplete.
  partialKeys?: readonly string[];
}

export interface PartialJsonResult {
  // undefined until the first value starts to settle.
  value: unknown;
  // true once the whole document has been read.
  complete: boolean;
  // A real syntax error (not just truncation); what was read before it is kept.
  error?: string;
}

export type LooseJsonResult = { ok: true; value: unknown } | { ok: false; error: string; at: number };

const DEFAULT_PARTIAL_KEYS: readonly string[] = ["ui"];
const MAX_DEPTH = 64;

interface ReadState {
  s: string;
  i: number;
  loose: boolean;
  partial: boolean;
  stopped: boolean;
  error: string | null;
  errorAt: number;
  partialKeys: ReadonlySet<string>;
}

// A read value. `done` false means the input ended (or broke) inside it.
interface Read {
  v: unknown;
  done: boolean;
  // Containers report their kind so a parent can decide whether to keep an
  // incomplete value; strings so a ui-like key can keep its prefix.
  kind: "object" | "array" | "string" | "scalar" | "none";
}

const NONE: Read = { v: undefined, done: false, kind: "none" };

export function parsePartialJson(prefix: unknown, opts: PartialJsonOptions = {}): PartialJsonResult {
  if (typeof prefix !== "string") return { value: undefined, complete: false, error: "input is not a string" };
  const st = makeState(prefix, false, true, opts.partialKeys ?? DEFAULT_PARTIAL_KEYS);
  const r = readValue(st, 0, true);
  if (r.done && !st.stopped) {
    skipWs(st);
    if (st.i < st.s.length) fail(st, `unexpected "${st.s[st.i]}" after the value`);
  }
  const out: PartialJsonResult = { value: r.kind === "none" ? undefined : r.v, complete: r.done && st.error == null };
  if (st.error != null) out.error = st.error;
  return out;
}

export function parseLooseJson(text: unknown): LooseJsonResult {
  if (typeof text !== "string") return { ok: false, error: "input is not a string", at: 0 };
  const st = makeState(text, true, false, []);
  const r = readValue(st, 0, false);
  if (st.error == null && r.done) {
    skipWs(st);
    if (st.i < st.s.length) fail(st, `unexpected "${st.s[st.i]}" after the value`);
  }
  if (st.error != null) return { ok: false, error: st.error, at: st.errorAt };
  if (!r.done) return { ok: false, error: "unexpected end of JSON", at: st.s.length };
  return { ok: true, value: r.v };
}

function makeState(s: string, loose: boolean, partial: boolean, keys: readonly string[]): ReadState {
  return { s, i: 0, loose, partial, stopped: false, error: null, errorAt: 0, partialKeys: new Set(keys) };
}

function fail(st: ReadState, message: string): void {
  if (st.error == null) {
    st.error = message;
    st.errorAt = st.i;
  }
  st.stopped = true;
}

function atEnd(st: ReadState): boolean {
  return st.stopped || st.i >= st.s.length;
}

function skipWs(st: ReadState): void {
  const s = st.s;
  while (st.i < s.length) {
    const c = s.charCodeAt(st.i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      st.i++;
      continue;
    }
    if (st.loose && c === 47 /* / */) {
      const n = s[st.i + 1];
      if (n === "/") {
        const nl = s.indexOf("\n", st.i + 2);
        st.i = nl < 0 ? s.length : nl + 1;
        continue;
      }
      if (n === "*") {
        const close = s.indexOf("*/", st.i + 2);
        st.i = close < 0 ? s.length : close + 2;
        continue;
      }
    }
    break;
  }
}

function readValue(st: ReadState, depth: number, topLevel: boolean): Read {
  skipWs(st);
  if (atEnd(st)) return NONE;
  if (depth > MAX_DEPTH) {
    fail(st, "nested too deeply");
    return NONE;
  }
  const c = st.s[st.i];
  if (c === "{") return readObject(st, depth, topLevel);
  if (c === "[") return readArray(st, depth);
  if (c === '"' || (st.loose && c === "'")) return readString(st);
  if (c === "-" || (c >= "0" && c <= "9")) return readNumber(st);
  return readLiteral(st);
}

function readObject(st: ReadState, depth: number, topLevel: boolean): Read {
  st.i++; // {
  const obj: Record<string, unknown> = {};
  for (;;) {
    skipWs(st);
    if (atEnd(st)) return { v: obj, done: false, kind: "object" };
    if (st.s[st.i] === "}") {
      st.i++;
      return { v: obj, done: true, kind: "object" };
    }
    const k = readKey(st);
    if (k == null) return { v: obj, done: false, kind: "object" };
    skipWs(st);
    if (atEnd(st)) return { v: obj, done: false, kind: "object" };
    if (st.s[st.i] !== ":") {
      fail(st, `expected ":" after key "${k}"`);
      return { v: obj, done: false, kind: "object" };
    }
    st.i++;
    const r = readValue(st, depth + 1, false);
    if (r.done) {
      setKey(obj, k, r.v);
    } else {
      // The value is still being written (or broke). Containers keep what has
      // settled; a string only under a streaming key of the top-level object.
      if (r.kind === "object" || r.kind === "array") setKey(obj, k, r.v);
      else if (r.kind === "string" && topLevel && st.partialKeys.has(k)) setKey(obj, k, r.v);
      return { v: obj, done: false, kind: "object" };
    }
    skipWs(st);
    if (atEnd(st)) return { v: obj, done: false, kind: "object" };
    const sep = st.s[st.i];
    if (sep === ",") {
      st.i++;
      if (st.loose) {
        skipWs(st);
        if (st.s[st.i] === "}") {
          st.i++;
          return { v: obj, done: true, kind: "object" };
        }
      }
      continue;
    }
    if (sep === "}") {
      st.i++;
      return { v: obj, done: true, kind: "object" };
    }
    fail(st, `expected "," or "}" after "${k}"`);
    return { v: obj, done: false, kind: "object" };
  }
}

// Own-property write that can never touch the prototype.
function setKey(obj: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function readKey(st: ReadState): string | null {
  const c = st.s[st.i];
  if (c === '"' || (st.loose && c === "'")) {
    const r = readString(st);
    return r.done ? (r.v as string) : null;
  }
  if (st.loose && /[A-Za-z_$]/.test(c)) {
    const start = st.i;
    while (st.i < st.s.length && /[\w$-]/.test(st.s[st.i])) st.i++;
    if (st.i >= st.s.length && st.partial) return null;
    return st.s.slice(start, st.i);
  }
  fail(st, `expected a quoted key, got "${c}"`);
  return null;
}

function readArray(st: ReadState, depth: number): Read {
  st.i++; // [
  const arr: unknown[] = [];
  for (;;) {
    skipWs(st);
    if (atEnd(st)) return { v: arr, done: false, kind: "array" };
    if (st.s[st.i] === "]") {
      st.i++;
      return { v: arr, done: true, kind: "array" };
    }
    const r = readValue(st, depth + 1, false);
    // Elements count only once complete, so a row never renders half-written.
    if (!r.done) return { v: arr, done: false, kind: "array" };
    arr.push(r.v);
    skipWs(st);
    if (atEnd(st)) return { v: arr, done: false, kind: "array" };
    const sep = st.s[st.i];
    if (sep === ",") {
      st.i++;
      if (st.loose) {
        skipWs(st);
        if (st.s[st.i] === "]") {
          st.i++;
          return { v: arr, done: true, kind: "array" };
        }
      }
      continue;
    }
    if (sep === "]") {
      st.i++;
      return { v: arr, done: true, kind: "array" };
    }
    fail(st, `expected "," or "]" in array`);
    return { v: arr, done: false, kind: "array" };
  }
}

const ESCAPES: Record<string, string> = { '"': '"', "'": "'", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function readString(st: ReadState): Read {
  const s = st.s;
  const quote = s[st.i];
  st.i++;
  let out = "";
  let runStart = st.i;
  while (st.i < s.length) {
    const c = s[st.i];
    if (c === quote) {
      out += s.slice(runStart, st.i);
      st.i++;
      return { v: out, done: true, kind: "string" };
    }
    if (c === "\\") {
      out += s.slice(runStart, st.i);
      const e = s[st.i + 1];
      if (e === undefined) {
        // A lone trailing backslash: the escape is still being written.
        st.i = s.length;
        return { v: out, done: false, kind: "string" };
      }
      if (e === "u") {
        const hex = s.slice(st.i + 2, st.i + 6);
        if (hex.length < 4 && st.i + 2 + hex.length >= s.length && /^[0-9a-fA-F]*$/.test(hex)) {
          st.i = s.length;
          return { v: out, done: false, kind: "string" };
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          fail(st, "bad \\u escape in string");
          return { v: out, done: false, kind: "string" };
        }
        out += String.fromCharCode(parseInt(hex, 16));
        st.i += 6;
      } else if (e in ESCAPES) {
        out += ESCAPES[e];
        st.i += 2;
      } else if (st.loose) {
        out += e;
        st.i += 2;
      } else {
        fail(st, `bad escape \\${e} in string`);
        return { v: out, done: false, kind: "string" };
      }
      runStart = st.i;
      continue;
    }
    if (c === "\n" && !st.loose) {
      fail(st, "unescaped newline in string");
      out += s.slice(runStart, st.i);
      return { v: out, done: false, kind: "string" };
    }
    st.i++;
  }
  out += s.slice(runStart, st.i);
  // A high surrogate at the cut is half a character — drop it.
  if (out.length && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return { v: out, done: false, kind: "string" };
}

function readNumber(st: ReadState): Read {
  const s = st.s;
  const start = st.i;
  while (st.i < s.length && /[-+0-9.eE]/.test(s[st.i])) st.i++;
  const raw = s.slice(start, st.i);
  if (st.i >= s.length && st.partial) return { v: undefined, done: false, kind: "scalar" };
  if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) {
    st.i = start;
    fail(st, `bad number "${raw}"`);
    return NONE;
  }
  return { v: Number(raw), done: true, kind: "scalar" };
}

const LITERALS: ReadonlyArray<readonly [string, unknown]> = [["true", true], ["false", false], ["null", null]];

function readLiteral(st: ReadState): Read {
  const rest = st.s.slice(st.i, st.i + 5);
  for (const [word, value] of LITERALS) {
    if (rest.startsWith(word)) {
      st.i += word.length;
      return { v: value, done: true, kind: "scalar" };
    }
    if (st.partial && st.i + rest.length >= st.s.length && word.startsWith(rest)) {
      st.i = st.s.length;
      return { v: undefined, done: false, kind: "scalar" };
    }
  }
  fail(st, `unexpected "${st.s[st.i]}"`);
  return NONE;
}
