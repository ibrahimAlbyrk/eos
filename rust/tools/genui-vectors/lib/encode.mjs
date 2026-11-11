// How vectors are written: plain JSON, with three markers for what JSON cannot
// hold or would hold wastefully. The Rust harness (tests/support) reads the same.
//   {"$undef":1}            an argument that is undefined
//   {"$rep":["a",24576]}    a string of one repeated character
//   {"$cat":[…]}            strings (or $rep) joined

// FNV-1a, 64 bit, over UTF-8 bytes; 16 hex digits. Two 32-bit halves in doubles:
// the corpus hashes ~100 MB, far too much for BigInt.
export function fnv1a64(text) {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    // × 0x100000001b3 = (h << 40) + h × 0x1b3, mod 2^64.
    const low = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(low / 4294967296) + lo * 256) % 4294967296;
    lo = low % 4294967296;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

// A seeded generator, so the fuzzed part of the corpus is the same on every run.
export function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const pick = (list) => list[int(list.length)];
  return { next, int, pick, chance: (p) => next() < p };
}

const RUN = /(.)\1{31,}/gsu;

function encodeString(s) {
  if (s.length < 48) return s;
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(RUN)) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push({ $rep: [m[1], m[0].length / m[1].length] });
    last = m.index + m[0].length;
  }
  if (!parts.length) return s;
  if (last < s.length) parts.push(s.slice(last));
  return parts.length === 1 ? parts[0] : { $cat: parts };
}

// A value as a vector stores it. Returns null for what no vector can hold (a
// function, a string that is not well-formed UTF-16: Rust cannot receive it).
export function encode(v) {
  const state = { ok: true };
  const out = enc(v, state);
  return state.ok ? { value: out } : null;
}

function enc(v, state) {
  if (v === undefined) return { $undef: 1 };
  if (typeof v === "string") {
    if (!v.isWellFormed()) state.ok = false;
    return encodeString(v);
  }
  if (typeof v === "function" || typeof v === "bigint" || typeof v === "symbol") {
    state.ok = false;
    return null;
  }
  if (typeof v === "number" && !Number.isFinite(v)) {
    state.ok = false;
    return null;
  }
  if (Array.isArray(v)) return v.map((x) => enc(x, state));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!k.isWellFormed() || k === "$undef" || k === "$rep" || k === "$cat") state.ok = false;
      if (x === undefined) continue;
      Object.defineProperty(out, k, { value: enc(x, state), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

// A result as a vector stores it: what JSON.stringify keeps, with a lone
// surrogate replaced by U+FFFD. That is what Node writes when such a string
// leaves the process as UTF-8, and what the Rust side holds.
export function wellFormed(v) {
  if (typeof v === "string") return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      Object.defineProperty(out, k.toWellFormed(), { value: wellFormed(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
