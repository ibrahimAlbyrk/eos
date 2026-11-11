// Writes the cross-implementation corpus for eos-contracts: for every exported
// Zod schema of contracts/src (minus genui), sample inputs and what Zod's
// safeParse answers for each. The Rust test parses the same inputs and must
// agree (tests/zod_vectors.rs).
//
//   node rust/tools/zod-port/vectors.mjs <repo> <out dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { T, load, optionsOf, unwrap } from "./load.mjs";

const [repo, outDir] = process.argv.slice(2);
const { exportsList, named } = await load(repo);
const problems = [];

const STRINGS = [
  "s", "abc", "main", "a1", "https://example.com/x", "/abs/path", "0".repeat(64), "v_abcdefghijkl",
  "123e4567-e89b-42d3-a456-426614174000", "st-abcdefgh", "2026-01-01T00:00:00.000Z", "03:00", "eos.pages",
  "1.2.3", "feature/x", "abcdef1", "Ab1", "note-1", "abc123", "t_abcdefgh", "sha256:" + "0".repeat(64),
  "a".repeat(40), "a".repeat(12), "a".repeat(16), "a".repeat(8), "a".repeat(32), "A".repeat(43), "A".repeat(22),
  "0".repeat(40), "0".repeat(12), "0".repeat(16), "0".repeat(32), "0".repeat(8), "1", "12", "eos-sync1.aGk.aGk",
  "eos://pair/abc", "#a1b2c3", "en", "tr-TR", "mem_abcdefgh", "p_abcdefghijkl", "x.png", "png", "@scope/pkg", "user@example.com",
  "2026-01-01", "pk_abcd1234", "pg-abcdefgh", "um-abcdefgh", "tr-abcdefgh", "A".repeat(86) + "==",
];
const NUMBERS = [1.5, 3, 1, 0, 100, 1000, 0.5, 60, 240, 1024, 20, -1, 5000];

function stringSample(s, mode) {
  const list = mode === "min" ? [...STRINGS].reverse() : STRINGS;
  for (const c of list) if (s.safeParse(c).success) return c;
  for (const c of ["a", "0", "A", "x1"]) for (const n of [2, 3, 5, 10, 20, 64, 100]) if (s.safeParse(c.repeat(n)).success) return c.repeat(n);
  problems.push(`no string sample for ${s._def.checks.map((c) => c.kind + (c.regex ? c.regex.source : c.value ?? "")).join(",")}`);
  return "s";
}

function numberSample(s, mode) {
  const list = mode === "min" ? [3, 1, 0, 100, 1.5, ...NUMBERS] : NUMBERS;
  for (const c of list) if (s.safeParse(c).success) return c;
  problems.push("no number sample");
  return 1;
}

const ABSENT = Symbol("absent");

function sample(s, mode, depth = 0) {
  const d = s._def;
  switch (T(s)) {
    case "ZodString": return stringSample(s, mode);
    case "ZodNumber": return numberSample(s, mode);
    case "ZodBoolean": return mode === "full";
    case "ZodNull": return null;
    case "ZodLiteral": return d.value;
    case "ZodEnum": return mode === "full" ? d.values[0] : d.values[d.values.length - 1];
    case "ZodUnknown": case "ZodAny": return mode === "full" ? { k: [1, "two", null, { z: true }] } : null;
    case "ZodOptional": case "ZodNullable": case "ZodDefault": return sample(d.innerType, mode, depth);
    case "ZodBranded": case "ZodReadonly": return sample(d.type ?? d.innerType, mode, depth);
    case "ZodEffects": {
      // A refinement the plain sample breaks: look for a nearby value it accepts.
      const v = sample(d.schema, mode, depth);
      if (s.safeParse(v).success) return v;
      if (typeof v === "string") for (const c of STRINGS) if (s.safeParse(c).success) return c;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const keys = Object.keys(v);
        for (const k of keys) { const c = { ...v }; delete c[k]; if (s.safeParse(c).success) return c; }
        for (const k of keys) for (const k2 of keys) { const c = { ...v }; delete c[k]; delete c[k2]; if (s.safeParse(c).success) return c; }
        if (mode === "min") return sample(s, "full", depth);
      }
      return v;
    }
    case "ZodLazy": return sample(d.getter(), depth > 2 ? "min" : mode, depth + 1);
    case "ZodArray": {
      const min = d.minLength?.value ?? d.exactLength?.value ?? 0;
      const max = d.maxLength?.value ?? d.exactLength?.value ?? Infinity;
      const n = mode === "full" ? Math.min(Math.max(min, 2), max) : min;
      return Array.from({ length: n }, (_, i) => sample(d.type, i === 0 ? mode : "min", depth + 1));
    }
    case "ZodTuple": return d.items.map((it) => sample(it, mode, depth + 1));
    case "ZodRecord": return mode === "full" ? { [stringSample(T(d.keyType) === "ZodString" ? d.keyType : { safeParse: () => ({ success: true }), _def: { checks: [] } }, "full")]: sample(d.valueType, mode, depth + 1) } : {};
    case "ZodObject": {
      const out = {};
      for (const [k, fs] of Object.entries(d.shape())) {
        if (mode === "min" && fs.safeParse(undefined).success) continue;
        if (mode === "min" && fs.safeParse(null).success) { out[k] = null; continue; }
        const v = sample(fs, depth > 4 ? "min" : mode, depth + 1);
        if (v !== ABSENT) out[k] = v;
      }
      return out;
    }
    case "ZodUnion": case "ZodDiscriminatedUnion": {
      const opts = optionsOf(s);
      return sample(mode === "full" ? opts[0] : opts[opts.length - 1], mode, depth + 1);
    }
    default: problems.push(`no sample for ${T(s)}`); return null;
  }
}

const coreOf = (s) => {
  let c = s;
  for (;;) {
    const t = T(c);
    if (["ZodOptional", "ZodNullable", "ZodDefault"].includes(t)) c = c._def.innerType;
    else if (t === "ZodEffects") c = c._def.schema;
    else if (t === "ZodBranded" || t === "ZodReadonly") c = c._def.type ?? c._def.innerType;
    else return c;
  }
};

// Values that break exactly one rule of a schema: [label, value].
function violations(s) {
  const c = coreOf(s);
  const d = c._def;
  const out = [];
  switch (T(c)) {
    case "ZodString": {
      out.push(["type", 42]);
      for (const k of d.checks) {
        if (k.kind === "min" && k.value >= 1) out.push(["min", "a".repeat(k.value - 1)]);
        if (k.kind === "max" && k.value <= 20000) out.push(["max", "a".repeat(k.value + 1)]);
        if (k.kind === "regex") out.push(["regex", "! bad value !"]);
        if (k.kind === "url") out.push(["url", "not a url"]);
      }
      break;
    }
    case "ZodNumber": {
      out.push(["type", "x"]);
      for (const k of d.checks) {
        if (k.kind === "min") out.push(["min", k.inclusive ? k.value - 1 : k.value]);
        if (k.kind === "max") out.push(["max", k.inclusive ? k.value + 1 : k.value]);
        if (k.kind === "int") out.push(["int", numberSample(c, "min") + 0.5]);
      }
      break;
    }
    case "ZodBoolean": out.push(["type", "x"]); break;
    case "ZodEnum": out.push(["enum", "__nope__"]); break;
    case "ZodLiteral": out.push(["literal", typeof d.value === "string" ? "__nope__" : typeof d.value === "number" ? d.value + 1 : !d.value]); break;
    case "ZodArray": {
      out.push(["type", "x"]);
      if (d.minLength?.value >= 1) out.push(["arr-min", []]);
      if (d.maxLength && d.maxLength.value <= 50) out.push(["arr-max", Array.from({ length: d.maxLength.value + 1 }, () => sample(d.type, "min"))]);
      break;
    }
    case "ZodObject": case "ZodRecord": out.push(["type", "x"]); break;
    default:
  }
  return out;
}

const MAX_INVALID = 10;

function casesFor(schema) {
  const cases = [];
  const full = sample(schema, "full");
  const min = sample(schema, "min");
  cases.push(["full", full]);
  if (JSON.stringify(min) !== JSON.stringify(full)) cases.push(["min", min]);
  const core = coreOf(schema);
  if (T(core) === "ZodUnion" || T(core) === "ZodDiscriminatedUnion") optionsOf(core).forEach((o, i) => cases.push([`option-${i}`, sample(o, "full")]));
  if (full && typeof full === "object" && !Array.isArray(full)) cases.push(["extra", { ...full, __extra: 1 }]);
  const invalid = [];
  if (T(core) === "ZodObject" && full && typeof full === "object") {
    for (const [k, fs] of Object.entries(core._def.shape())) {
      if (!fs.safeParse(undefined).success && k in full) { const c = { ...full }; delete c[k]; invalid.push([`missing:${k}`, c]); }
      for (const [label, v] of violations(fs)) invalid.push([`${label}:${k}`, { ...full, [k]: v }]);
    }
  } else for (const [label, v] of violations(schema)) invalid.push([label, v]);
  // Spread the kept ones over the fields instead of taking the first few.
  const step = Math.max(1, Math.ceil(invalid.length / MAX_INVALID));
  for (let i = 0; i < invalid.length; i += step) cases.push(invalid[i]);
  return cases;
}

const memberOf = new Map();
for (const e of exportsList) {
  if (!e.schema) continue;
  const c = coreOf(e.value);
  if (T(c) === "ZodDiscriminatedUnion") for (const o of optionsOf(c)) if (named.has(o) && !memberOf.has(o)) memberOf.set(o, e);
}
// Members reached only through a nested union still need a parent.
{
  const seen = new Set();
  const walk = (s) => {
    if (!s?._def || seen.has(s)) return;
    seen.add(s);
    const d = s._def;
    if (T(s) === "ZodObject") for (const v of Object.values(d.shape())) walk(v);
    for (const k of ["innerType", "type", "schema", "valueType"]) walk(d[k]);
    if (d.options) for (const o of optionsOf(s)) walk(o);
    if (T(s) === "ZodDiscriminatedUnion") for (const o of optionsOf(s)) if (named.has(o) && !memberOf.has(o)) problems.push(`union member ${named.get(o).rust} has no exported parent union`);
  };
  for (const e of exportsList) if (e.schema) walk(e.value);
}

mkdirSync(outDir, { recursive: true });
const byMod = new Map();
const dispatch = [];
let total = 0;
for (const e of exportsList) {
  if (!e.schema || e.opaque) continue;
  const target = e.aliasOf ?? e;
  const parent = memberOf.get(target.value);
  dispatch.push(`    ${JSON.stringify(e.name)} => ${(parent ?? target).rust},`);
  const file = e.mod.replace("::", "_");
  if (!byMod.has(file)) byMod.set(file, []);
  for (const [label, input] of casesFor(e.value)) {
    const r = e.value.safeParse(input);
    const row = { schema: e.name, case: label, input, ok: r.success };
    if (parent) row.member = true;
    if (r.success) row.output = JSON.parse(JSON.stringify(r.data) ?? "null");
    else row.issues = r.error.issues.map((i) => ({ path: i.path.map(String), message: i.message, code: i.code }));
    byMod.get(file).push(row);
    total++;
  }
}
for (const [file, rows] of byMod) writeFileSync(join(outDir, `${file}.json`), "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n");
writeFileSync(join(outDir, "dispatch.rs"), `// Written by rust/tools/zod-port/vectors.mjs: Zod schema name → Rust type.\ndispatch! {\n${dispatch.join("\n")}\n}\n`);
// Values the Rust port rebuilds by hand.
const golden = join(outDir, "../golden");
mkdirSync(golden, { recursive: true });
const ns = Object.fromEntries(exportsList.map((e) => [e.name, e.value]));
writeFileSync(join(golden, "builtin_plugin_manifests.json"), JSON.stringify(ns.BUILTIN_PLUGIN_MANIFESTS) + "\n");
// ROUTES as path templates: each parameter replaced by `:<its name in the source>`.
const routes = Object.entries(ns.ROUTES).map(([name, v]) => {
  if (typeof v === "string") return { name, path: v, params: [] };
  const params = /^\(([^)]*)\)/.exec(v.toString())[1].split(",").map((p) => p.trim().split(/[:\s]/)[0]).filter(Boolean);
  return { name, path: v(...params.map((p) => `:${p}`)), params };
});
writeFileSync(join(golden, "routes.json"), JSON.stringify(routes, null, 1) + "\n");
console.log(`schemas: ${dispatch.length}, vectors: ${total}, routes: ${routes.length}`);
if (problems.length) console.log([...new Set(problems)].join("\n"));
