// One-off scaffold: walks the Zod schemas of contracts/src and writes the serde
// types of eos-contracts. Run once per module while porting; the Rust files are
// edited by hand afterwards and are the source of truth from then on.
//
//   node rust/tools/zod-port/port.mjs <repo> <out dir> [module filter]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { T, load, optionsOf, unwrap } from "./load.mjs";

const [repo, outDir, only] = process.argv.slice(2);
const { exportsList, named } = await load(repo);

const KEYWORDS = new Set("as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while async await dyn abstract become box do final macro override priv typeof unsized virtual yield try".split(" "));
const TAKEN = new Set(["Option", "Result", "String", "Vec", "Box", "Value", "Num", "Some", "None", "Ok", "Err", "Issues", "Validate"]);
const report = [];
const note = (m) => report.push(m);

const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
const pascal = (s) => { const p = words(String(s)).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(""); return /^[0-9]/.test(p) ? `N${p}` : p || "Empty"; };
const snake = (s) => words(s).map((w) => w.toLowerCase()).join("_");
const serdeCamel = (sn) => sn.split("_").map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("");
const rstr = (s) => JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
const rawstr = (s) => (s.includes('"') ? `r#"${s}"#` : `r"${s}"`);
const fnum = (n) => (Number.isInteger(n) ? `${n}.0` : String(n));

// serde's rename_all rules applied to a PascalCase variant name.
const RULES = {
  lowercase: (v) => v.toLowerCase(),
  UPPERCASE: (v) => v.toUpperCase(),
  camelCase: (v) => v[0].toLowerCase() + v.slice(1),
  snake_case: (v) => v.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase()),
  SCREAMING_SNAKE_CASE: (v) => v.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c).toUpperCase(),
  "kebab-case": (v) => v.replace(/[A-Z]/g, (c, i) => (i ? "-" : "") + c.toLowerCase()),
  PascalCase: (v) => v,
};

const mods = new Map();
const modOf = (path) => {
  if (!mods.has(path)) mods.set(path, { path, out: [], imports: new Map(), lits: new Map(), usesMap: false, usesValue: false, usesNum: false, usesRe: false });
  return mods.get(path);
};
const anon = new Map(); // schema object → { rust, mod }
const usedNames = new Map(); // rust name → module path
for (const e of exportsList) if (e.schema && !e.aliasOf && !e.opaque) usedNames.set(e.rust, e.mod);

// Named objects that are options of a discriminated union lose the tag field:
// the enum carries it.
const memberTag = new Map();
{
  const seen = new Set();
  const walk = (s) => {
    if (!s?._def || seen.has(s)) return;
    seen.add(s);
    const d = s._def;
    if (T(s) === "ZodDiscriminatedUnion") for (const o of optionsOf(s)) if (named.has(o)) memberTag.set(o, d.discriminator);
    if (T(s) === "ZodObject") for (const v of Object.values(d.shape())) walk(v);
    for (const k of ["innerType", "type", "schema", "valueType", "keyType", "left", "right"]) walk(d[k]);
    if (d.options) for (const o of optionsOf(s)) walk(o);
    if (d.items) for (const o of d.items) walk(o);
    if (T(s) === "ZodLazy") walk(d.getter());
  };
  for (const e of exportsList) if (e.schema) walk(e.value);
}

const hasValMemo = new Map();
function hasVal(s) {
  if (named.get(s)?.opaque) return false;
  if (hasValMemo.has(s)) return hasValMemo.get(s);
  hasValMemo.set(s, false);
  const d = s._def;
  let r = false;
  switch (T(s)) {
    case "ZodString": r = d.checks.some((c) => c.kind !== "trim"); break;
    case "ZodNumber": r = d.checks.some((c) => c.kind !== "int" && c.kind !== "finite"); break;
    case "ZodArray": r = !!(d.minLength || d.maxLength || d.exactLength) || hasVal(d.type); break;
    case "ZodRecord": r = hasVal(d.keyType) || hasVal(d.valueType); break;
    case "ZodObject": r = Object.values(d.shape()).some(hasVal); break;
    case "ZodUnion": case "ZodDiscriminatedUnion": r = optionsOf(s).some(hasVal); break;
    case "ZodOptional": case "ZodNullable": case "ZodDefault": r = hasVal(d.innerType); break;
    case "ZodBranded": case "ZodReadonly": r = hasVal(d.type ?? d.innerType); break;
    case "ZodEffects": r = true; break;
    case "ZodLazy": r = hasVal(d.getter()); break;
    case "ZodTuple": r = d.items.some(hasVal); break;
    default: r = false;
  }
  hasValMemo.set(s, r);
  return r;
}

function refTo(mod, target) {
  if (target.opaque) return "Value";
  if (target.mod !== mod.path) {
    if (!mod.imports.has(target.mod)) mod.imports.set(target.mod, new Set());
    mod.imports.get(target.mod).add(target.rust);
  }
  return target.rust;
}

function freshName(mod, hint) {
  let name = hint, i = 2;
  while (usedNames.has(name) || TAKEN.has(name)) name = `${hint}${i++}`;
  usedNames.set(name, mod.path);
  return name;
}

function litType(mod, value) {
  if (typeof value === "boolean") return `BoolLit<${value}>`;
  if (typeof value === "number" && Number.isInteger(value)) return `IntLit<${value}>`;
  if (typeof value !== "string") { note(`${mod.path}: literal ${JSON.stringify(value)} needs a hand-written type`); return "Value"; }
  if (!mod.lits.has(value)) mod.lits.set(value, freshName(mod, `${pascal(value)}Lit`));
  return mod.lits.get(value);
}

// The Rust type of a schema used inside a field or container.
function typeOf(mod, s, hint, opts = {}) {
  if (named.has(s) && s !== opts.self) {
    const target = named.get(s);
    if (memberTag.has(s) && !opts.inUnion && !target.opaque) note(`${mod.path}: ${hint} uses union member ${target.rust} on its own (its "${memberTag.get(s)}" tag is on the enum)`);
    return refTo(mod, target);
  }
  if (anon.has(s)) return refTo(mod, anon.get(s));
  const d = s._def;
  switch (T(s)) {
    case "ZodString": return "String";
    case "ZodNumber": if (d.checks.some((c) => c.kind === "int")) return "i64"; mod.usesNum = true; return "Num";
    case "ZodBoolean": return "bool";
    case "ZodNull": return "()";
    case "ZodUnknown": case "ZodAny": mod.usesValue = true; return "Value";
    case "ZodLiteral": return litType(mod, d.value);
    case "ZodOptional": case "ZodNullable": {
      const inner = typeOf(mod, d.innerType, hint, opts);
      return inner.startsWith("Option<") ? inner : `Option<${inner}>`;
    }
    case "ZodDefault": return typeOf(mod, d.innerType, hint, opts);
    case "ZodBranded": case "ZodReadonly": return typeOf(mod, d.type ?? d.innerType, hint, opts);
    case "ZodEffects": return typeOf(mod, d.schema, hint, opts);
    case "ZodArray": return `Vec<${typeOf(mod, d.type, `${hint}Item`)}>`;
    case "ZodTuple": return `(${d.items.map((it, i) => typeOf(mod, it, `${hint}${i}`)).join(", ")})`;
    case "ZodRecord": mod.usesMap = true; return `IndexMap<String, ${typeOf(mod, d.valueType, `${hint}Value`)}>`;
    case "ZodObject": case "ZodEnum": case "ZodUnion": case "ZodDiscriminatedUnion": {
      const alias = unionAlias(mod, s, hint);
      if (alias) return alias;
      const rust = freshName(mod, hint);
      anon.set(s, { rust, mod: mod.path });
      emitDef(mod, rust, s);
      return rust;
    }
    case "ZodLazy": { const g = d.getter(); return named.has(g) ? `Box<${refTo(mod, named.get(g))}>` : (note(`${mod.path}: ${hint} lazy`), "Value"); }
    default: note(`${mod.path}: ${hint} unsupported ${T(s)}`); mod.usesValue = true; return "Value";
  }
}

// `z.union([X, z.null()])` is just a nullable X.
function unionAlias(mod, s, hint) {
  if (T(s) !== "ZodUnion") return null;
  const opts = optionsOf(s);
  const rest = opts.filter((o) => T(o) !== "ZodNull");
  if (rest.length === 1 && opts.length === 2) return `Option<${typeOf(mod, rest[0], hint)}>`;
  return null;
}

function emitDef(mod, rust, s, top = {}) {
  switch (T(s)) {
    case "ZodObject": return emitStruct(mod, rust, s, top);
    case "ZodEnum": return emitEnum(mod, rust, s._def.values);
    case "ZodDiscriminatedUnion": return emitTagged(mod, rust, s);
    case "ZodUnion": return emitUnion(mod, rust, s);
    default: throw new Error(`emitDef ${rust} ${T(s)}`);
  }
}

function emitEnum(mod, rust, values) {
  const vars = values.map((v) => ({ v, name: pascal(v) }));
  if (new Set(vars.map((x) => x.name)).size !== vars.length) note(`${mod.path}: enum ${rust} has colliding variant names`);
  const rule = Object.keys(RULES).find((r) => vars.every((x) => RULES[r](x.name) === x.v));
  const o = mod.out;
  o.push("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]");
  if (rule && rule !== "PascalCase") o.push(`#[serde(rename_all = "${rule}")]`);
  o.push(`pub enum ${rust} {`);
  for (const x of vars) {
    if (!rule) o.push(`    #[serde(rename = ${rstr(x.v)})]`);
    o.push(`    ${x.name},`);
  }
  o.push("}", "", `impl Validate for ${rust} {}`, "");
}

function fieldDecl(mod, parent, json, schema) {
  const u = unwrap(schema, named);
  const core = u.core;
  const kind = T(core);
  let rustName = snake(json);
  if (!rustName || /^[0-9]/.test(rustName)) rustName = `f_${rustName}`;
  const ident = KEYWORDS.has(rustName) ? `r#${rustName}` : rustName;
  const attrs = [];
  const hint = `${parent}${pascal(json)}`;
  const trim = kind === "ZodString" && core._def.checks.some((c) => c.kind === "trim") && !named.has(core);
  const unknown = (kind === "ZodUnknown" || kind === "ZodAny") && !named.has(core);
  let ty = typeOf(mod, core, hint);
  let optDepth = 0;
  let extra = null;
  if (unknown) {
    ty = "Option<Value>"; optDepth = 1;
    attrs.push('default', 'skip_serializing_if = "Option::is_none"', 'deserialize_with = "de::some"');
    mod.usesDe = true;
    if (u.def) note(`${mod.path}: ${parent}.${json} unknown with default`);
  } else if (u.def) {
    const d = defaultExpr(mod, core, u.def.value, ty, u.nullable);
    if (u.nullable) { ty = `Option<${ty}>`; optDepth = 1; }
    if (d === null) attrs.push("default");
    else if (d === "yes") { attrs.push('default = "yes"'); mod.usesYes = true; }
    else {
      const fn = `${snake(parent)}_${rustName}_default`;
      attrs.push(`default = "${fn}"`);
      extra = `fn ${fn}() -> ${ty} {\n    ${d}\n}\n`;
    }
    if (trim) { attrs.push(`deserialize_with = "de::trimmed${u.nullable ? "_opt" : ""}"`); mod.usesDe = true; }
  } else if (u.optional && u.nullable) {
    ty = `Option<Option<${ty}>>`; optDepth = 2;
    attrs.push('default', 'skip_serializing_if = "Option::is_none"', 'deserialize_with = "de::nullable"');
    if (trim) note(`${mod.path}: ${parent}.${json} trimmed nullable+optional string`);
  } else if (u.optional || u.nullable) {
    if (!ty.startsWith("Option<")) { ty = `Option<${ty}>`; optDepth = 1; } else optDepth = 1;
    if (u.optional) attrs.push("default", 'skip_serializing_if = "Option::is_none"');
    if (trim) { attrs.push(...(u.optional ? [] : ["default"]), 'deserialize_with = "de::trimmed_opt"'); mod.usesDe = true; }
  } else if (trim) { attrs.push('deserialize_with = "de::trimmed"'); mod.usesDe = true; }
  if (core._def.coerce && !named.has(core)) {
    const fn = kind === "ZodBoolean" ? "coerce_bool" : kind === "ZodNumber" && ty.includes("i64") ? "coerce_int" : null;
    if (!fn || optDepth > 1) note(`${mod.path}: ${parent}.${json} coercion of ${ty} not ported`);
    else attrs.push(`deserialize_with = "de::${fn}${optDepth ? "_opt" : ""}"`);
  }
  return { json, rustName, ident, attrs, ty, optDepth, core, extra, schema };
}

function defaultExpr(mod, core, value, ty, nullable) {
  const wrap = (e) => (nullable ? `Some(${e})` : e);
  if (value === null) return null;
  let s = core;
  while (named.has(s) && ["ZodOptional", "ZodNullable", "ZodDefault"].includes(T(s))) s = s._def.innerType;
  switch (T(s)) {
    case "ZodString": return value === "" && !nullable ? null : wrap(`${rstr(value)}.to_owned()`);
    case "ZodNumber": {
      if (value === 0 && !nullable) return null;
      return wrap(ty === "i64" ? `${value}` : `Num(${fnum(value)})`);
    }
    case "ZodBoolean": return value === false && !nullable ? null : !nullable && value === true ? "yes" : wrap(String(value));
    case "ZodArray": if (value.length === 0 && !nullable) return null; break;
    case "ZodRecord": if (Object.keys(value).length === 0 && !nullable) return null; break;
    case "ZodEnum": return wrap(`${ty}::${pascal(value)}`);
    default:
  }
  const e = valueExpr(mod, s, value, ty);
  if (e) return wrap(e);
  note(`${mod.path}: default ${JSON.stringify(value)} for ${ty} needs a hand-written function`);
  return "unimplemented!()";
}

// A Rust expression for a JSON value of a schema's type (defaults that are objects or lists).
function valueExpr(mod, s, value, ty) {
  while (["ZodOptional", "ZodNullable", "ZodDefault"].includes(T(s))) s = s._def.innerType;
  switch (T(s)) {
    case "ZodString": return `${rstr(value)}.to_owned()`;
    case "ZodNumber": return ty === "i64" || s._def.checks.some((c) => c.kind === "int") ? `${value}` : `Num(${fnum(value)})`;
    case "ZodBoolean": return String(value);
    case "ZodEnum": return `${ty}::${pascal(value)}`;
    case "ZodArray": {
      if (!value.length) return "Vec::new()";
      const item = typeOf(mod, s._def.type, `${ty}Item`);
      const parts = value.map((v) => valueExpr(mod, s._def.type, v, item));
      return parts.every(Boolean) ? `vec![${parts.join(", ")}]` : null;
    }
    case "ZodRecord": return Object.keys(value).length ? null : "IndexMap::new()";
    case "ZodObject": {
      const fields = [];
      for (const [k, fs] of Object.entries(s._def.shape())) {
        const f = fieldDecl(mod, ty, k, fs);
        const u = unwrap(fs, named);
        const v = value[k] === undefined && u.def ? u.def.value : value[k];
        let e;
        if (v === undefined || v === null) e = "None";
        else {
          const inner = f.ty.replace(/^Option<(.*)>$/, "$1").replace(/^Option<(.*)>$/, "$1");
          e = valueExpr(mod, u.core, v, inner);
          if (!e) return null;
          for (let i = 0; i < f.optDepth; i++) e = `Some(${e})`;
        }
        fields.push(`${f.ident}: ${e}`);
      }
      if (s._def.unknownKeys === "passthrough") fields.push("extra: serde_json::Map::new()");
      return `${ty} { ${fields.join(", ")} }`;
    }
    default: return null;
  }
}

function emitStruct(mod, rust, s, top = {}) {
  const d = s._def;
  const mark = mod.out.length;
  const strip = top.stripField;
  const fields = Object.entries(d.shape()).filter(([k]) => k !== strip).map(([k, v]) => fieldDecl(mod, rust, k, v));
  const camel = fields.every((f) => serdeCamel(f.rustName) === f.json);
  const plain = fields.every((f) => f.rustName === f.json);
  const o = [];
  o.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]");
  const sattrs = [];
  if (!plain && camel) sattrs.push('rename_all = "camelCase"');
  if (d.unknownKeys === "strict") sattrs.push("deny_unknown_fields");
  if (sattrs.length) o.push(`#[serde(${sattrs.join(", ")})]`);
  o.push(`pub struct ${rust} {`);
  for (const f of fields) {
    const a = [...f.attrs];
    const needsRename = plain ? false : camel ? false : f.rustName !== f.json;
    if (needsRename) a.unshift(`rename = ${rstr(f.json)}`);
    if (a.length) o.push(`    #[serde(${a.join(", ")})]`);
    o.push(`    pub ${f.ident}: ${f.ty},`);
  }
  if (d.unknownKeys === "passthrough") {
    o.push("    /// Keys this version does not know; kept so a round trip loses nothing.", "    #[serde(flatten)]", "    pub extra: serde_json::Map<String, Value>,");
    mod.usesValue = true;
  }
  if (T(d.catchall) !== "ZodNever") note(`${mod.path}: ${rust} has a catchall`);
  o.push("}", "");
  for (const f of fields) if (f.extra) o.push(f.extra);
  const checks = [];
  for (const f of fields) {
    if (!hasVal(f.schema)) continue;
    const body = genVal(mod, f.core, `self.${f.ident}`, false, f.optDepth);
    if (!body.length) continue;
    if (body.length === 1 && !body[0].includes("\n") && !body[0].startsWith("if ") && !body[0].startsWith("for ")) checks.push(`cx.at(${rstr(f.json)}, |cx| ${body[0].replace(/;$/, "")});`);
    else checks.push(`cx.at(${rstr(f.json)}, |cx| {`, ...body.map((l) => `    ${l}`), "});");
  }
  if (checks.length) o.push(`impl Validate for ${rust} {`, "    fn validate(&self, cx: &mut Issues) {", ...checks.map((l) => `        ${l}`), "    }", "}", "");
  else o.push(`impl Validate for ${rust} {}`, "");
  mod.out.splice(mark, 0, ...o);
}

// Statements that check `expr` (a place of the schema's type; `isRef` when it is a reference).
function genVal(mod, s, expr, isRef, optDepth = 0, top = false) {
  if (optDepth > 0) {
    const inner = genVal(mod, s, "v", true, 0, top);
    if (!inner.length) return [];
    const pat = optDepth === 2 ? "Some(Some(v))" : "Some(v)";
    return [`if let ${pat} = ${isRef ? expr : `&${expr}`} {`, ...inner.map((l) => `    ${l}`), "}"];
  }
  if (!top && (named.has(s) || anon.has(s))) return hasVal(s) ? [`${expr}.validate(cx);`] : [];
  const d = s._def;
  const str = isRef ? expr : `&${expr}`;
  const val = isRef ? `*${expr}` : expr;
  switch (T(s)) {
    case "ZodString": {
      const out = [];
      for (const c of d.checks) {
        if (c.message && c.kind !== "regex") note(`${mod.path}: ${expr} ${c.kind} has a custom message: ${c.message}`);
        if (c.kind === "min") out.push(`cx.str_min(${str}, ${c.value});`);
        else if (c.kind === "max") out.push(`cx.str_max(${str}, ${c.value});`);
        else if (c.kind === "length") out.push(`cx.str_len(${str}, ${c.value});`);
        else if (c.kind === "url") out.push(`cx.url(${str});`);
        else if (c.kind === "uuid") out.push(`cx.uuid(${str});`);
        else if (c.kind === "datetime" && !c.offset && !c.local && c.precision == null) out.push(`cx.datetime(${str});`);
        else if (c.kind === "startsWith") out.push(`cx.starts_with(${str}, ${rstr(c.value)});`);
        else if (c.kind === "regex") {
          mod.usesRe = true;
          const flags = c.regex.flags ? `, ${rstr(c.regex.flags)}` : "";
          out.push(`cx.regex(${str}, re!(${rawstr(c.regex.source)}${flags}), ${c.message ? `Some(${rstr(c.message)})` : "None"});`);
        } else if (c.kind !== "trim") note(`${mod.path}: ${expr} string check ${c.kind} not ported`);
      }
      return out;
    }
    case "ZodNumber": {
      const int = d.checks.some((c) => c.kind === "int");
      const out = [];
      for (const c of d.checks) {
        if (c.message) note(`${mod.path}: ${expr} ${c.kind} has a custom message: ${c.message}`);
        if (c.kind === "min" || c.kind === "max") out.push(`cx.${int ? "int" : "num"}_${c.kind}(${val}, ${int ? c.value : fnum(c.value)}, ${c.inclusive});`);
        else if (c.kind !== "int" && c.kind !== "finite") note(`${mod.path}: ${expr} number check ${c.kind} not ported`);
      }
      return out;
    }
    case "ZodArray": {
      const out = [];
      if (d.exactLength) note(`${mod.path}: ${expr} exact array length not ported`);
      if (d.minLength) out.push(`cx.arr_min(${expr}.len(), ${d.minLength.value});`);
      if (d.maxLength) out.push(`cx.arr_max(${expr}.len(), ${d.maxLength.value});`);
      if (hasVal(d.type)) {
        const inner = genVal(mod, d.type, "v", true);
        if (inner.length === 1 && inner[0] === "v.validate(cx);") out.push(`${expr}.validate(cx);`);
        else if (inner.length) out.push(`for (i, v) in ${expr}.iter().enumerate() {`, "    cx.idx(i, |cx| {", ...inner.map((l) => `        ${l}`), "    });", "}");
      }
      return out;
    }
    case "ZodRecord": {
      const keyChecks = hasVal(d.keyType) ? genVal(mod, d.keyType, "k", true) : [];
      const valChecks = hasVal(d.valueType) ? genVal(mod, d.valueType, "v", true) : [];
      if (!keyChecks.length && valChecks.length === 1 && valChecks[0] === "v.validate(cx);") return [`${expr}.validate(cx);`];
      if (!keyChecks.length && !valChecks.length) return [];
      return [`for (k, v) in ${isRef ? expr : `&${expr}`} {`, "    cx.at(k, |cx| {", ...[...keyChecks, ...valChecks].map((l) => `        ${l}`), "    });", "}"];
    }
    case "ZodOptional": case "ZodNullable": {
      const inner = genVal(mod, d.innerType, "v", true);
      return inner.length ? [`if let Some(v) = ${isRef ? expr : `&${expr}`} {`, ...inner.map((l) => `    ${l}`), "}"] : [];
    }
    case "ZodDefault": return genVal(mod, d.innerType, expr, isRef);
    case "ZodBranded": case "ZodReadonly": return genVal(mod, d.type ?? d.innerType, expr, isRef);
    case "ZodEffects": return [...genVal(mod, d.schema, expr, isRef), `// TODO(port): ${d.effect.type} on ${expr}`];
    case "ZodLazy": return [`${expr}.validate(cx);`];
    default: if (hasVal(s)) note(`${mod.path}: ${expr} validation of ${T(s)} not ported`); return [];
  }
}

function emitTagged(mod, rust, s) {
  const tag = s._def.discriminator;
  // serde tags are strings; a union told apart by `ok: true | false` keeps the
  // literal field on each option and is tried in order.
  if (optionsOf(s).some((o) => T(o.shape[tag]) === "ZodLiteral" && typeof o.shape[tag]._def.value !== "string")) return emitUnion(mod, rust, s);
  const mark = mod.out.length;
  const vars = [];
  for (const opt of optionsOf(s)) {
    const tagSchema = opt.shape[tag];
    const values = T(tagSchema) === "ZodLiteral" ? [tagSchema._def.value] : T(tagSchema) === "ZodEnum" ? tagSchema._def.values : null;
    if (!values) { note(`${mod.path}: ${rust} tag of an option is ${T(tagSchema)}`); continue; }
    for (const value of values) {
      let inner = null;
      if (named.has(opt)) inner = typeOf(mod, opt, rust, { inUnion: true });
      else if (Object.keys(opt.shape).length > 1 || opt._def.unknownKeys !== "strip") {
        inner = freshName(mod, `${rust}${pascal(value)}`);
        emitStruct(mod, inner, opt, { stripField: tag });
        anon.set(opt, { rust: inner, mod: mod.path });
      }
      vars.push({ value, name: pascal(value), inner, opt });
    }
  }
  const rule = Object.keys(RULES).find((r) => vars.every((x) => RULES[r](x.name) === x.value));
  const o = [];
  o.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]");
  o.push(`#[serde(tag = ${rstr(tag)}${rule && rule !== "PascalCase" ? `, rename_all = "${rule}"` : ""})]`);
  o.push(`pub enum ${rust} {`);
  for (const x of vars) {
    if (!rule) o.push(`    #[serde(rename = ${rstr(String(x.value))})]`);
    o.push(x.inner ? `    ${x.name}(${x.inner}),` : `    ${x.name},`);
  }
  o.push("}", "");
  const arms = vars.filter((x) => x.inner && hasVal(x.opt)).map((x) => `            Self::${x.name}(v) => v.validate(cx),`);
  if (arms.length) {
    o.push(`impl Validate for ${rust} {`, "    fn validate(&self, cx: &mut Issues) {", "        match self {", ...arms);
    if (arms.length < vars.length) o.push("            _ => {}");
    o.push("        }", "    }", "}", "");
  } else o.push(`impl Validate for ${rust} {}`, "");
  mod.out.splice(mark, 0, ...o);
}

function emitUnion(mod, rust, s) {
  const mark = mod.out.length;
  const opts = optionsOf(s);
  if (opts.every((o) => T(o) === "ZodLiteral" && typeof o._def.value === "string")) return emitEnum(mod, rust, opts.map((o) => o._def.value));
  const vars = opts.map((opt, i) => {
    const k = T(opt);
    const base = named.has(opt) ? named.get(opt).rust
      : k === "ZodString" ? "Text" : k === "ZodNumber" ? "Number" : k === "ZodBoolean" ? "Flag" : k === "ZodArray" ? "List"
      : k === "ZodRecord" ? "Map" : k === "ZodNull" ? "Null" : k === "ZodLiteral" ? pascal(opt._def.value)
      : s._def.discriminator ? pascal(String(opt.shape[s._def.discriminator]._def.value)) : `V${i + 1}`;
    return { name: base, ty: typeOf(mod, opt, `${rust}${base}`), opt };
  });
  if (new Set(vars.map((v) => v.name)).size !== vars.length) vars.forEach((v, i) => { v.name = `${v.name}${i + 1}`; });
  const o = [];
  o.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]", "#[serde(untagged)]", `pub enum ${rust} {`);
  for (const v of vars) o.push(v.ty === "()" ? `    ${v.name},` : `    ${v.name}(${v.ty}),`);
  o.push("}", "");
  const arms = [];
  for (const v of vars) {
    if (!hasVal(v.opt)) continue;
    const body = genVal(mod, v.opt, "v", true);
    if (body.length === 1) arms.push(`            Self::${v.name}(v) => ${body[0].replace(/;$/, "")},`);
    else if (body.length) arms.push(`            Self::${v.name}(v) => {`, ...body.map((l) => `                ${l}`), "            }");
  }
  if (arms.length) {
    o.push(`impl Validate for ${rust} {`, "    fn validate(&self, cx: &mut Issues) {", "        match self {", ...arms);
    if (vars.some((v) => !hasVal(v.opt))) o.push("            _ => {}");
    o.push("        }", "    }", "}", "");
  } else o.push(`impl Validate for ${rust} {}`, "");
  mod.out.splice(mark, 0, ...o);
}

function emitExport(e) {
  const mod = modOf(e.mod);
  if (TAKEN.has(e.rust)) note(`${e.mod}: ${e.rust} shadows a common name`);
  if (e.aliasOf) { mod.out.push(`pub type ${e.rust} = ${refTo(mod, e.aliasOf)};`, ""); return; }
  let s = e.value;
  const effects = [];
  while (T(s) === "ZodEffects" && !(named.has(s._def.schema))) { effects.push(s._def.effect.type); s = s._def.schema; }
  if (effects.length) note(`${e.mod}: ${e.rust} has ${effects.join("+")} — port by hand (${e.file}:${e.line})`);
  const k = T(s);
  if (k === "ZodObject") emitStruct(mod, e.rust, s, memberTag.has(e.value) ? { stripField: memberTag.get(e.value) } : {});
  else if (k === "ZodEnum" || k === "ZodDiscriminatedUnion" || (k === "ZodUnion" && !unionAlias(mod, s, e.rust))) emitDef(mod, e.rust, s);
  else if (k === "ZodLazy") { note(`${e.mod}: ${e.rust} is lazy — port by hand (${e.file}:${e.line})`); mod.out.push(`pub type ${e.rust} = Value;`, ""); }
  else {
    const ty = typeOf(mod, s, e.rust, { self: e.value });
    const checks = hasVal(s) ? genVal(mod, s, "self.0", false, ty.startsWith("Option<") ? 1 : 0, true) : [];
    if (checks.length || k === "ZodString" || k === "ZodNumber") {
      if (k === "ZodString" && s._def.checks.some((c) => c.kind === "trim")) note(`${e.mod}: ${e.rust} newtype trims`);
      mod.out.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]", "#[serde(transparent)]", `pub struct ${e.rust}(pub ${ty});`, "");
      if (checks.length) mod.out.push(`impl Validate for ${e.rust} {`, "    fn validate(&self, cx: &mut Issues) {", ...checks.map((l) => `        ${l}`), "    }", "}", "");
      else mod.out.push(`impl Validate for ${e.rust} {}`, "");
    } else mod.out.push(`pub type ${e.rust} = ${ty};`, "");
  }
}

function emitConst(e) {
  const mod = modOf(e.mod);
  const v = e.value;
  const o = mod.out;
  if (typeof v === "string") o.push(`pub const ${e.name}: &str = ${rstr(v)};`, "");
  else if (typeof v === "number") o.push(`pub const ${e.name}: ${Number.isInteger(v) ? "i64" : "f64"} = ${v};`, "");
  else if (typeof v === "boolean") o.push(`pub const ${e.name}: bool = ${v};`, "");
  else if (v instanceof RegExp) o.push(`pub const ${e.name}: &str = ${rawstr(v.source)};`, "");
  else if (Array.isArray(v) && v.every((x) => typeof x === "string")) o.push(`pub const ${e.name}: &[&str] = &[${v.map(rstr).join(", ")}];`, "");
  else note(`${e.mod}: const ${e.name} (${typeof v === "function" ? "function" : "object"}) — port by hand (${e.file}:${e.line})`);
}

for (const e of exportsList) {
  if (only && !e.mod.startsWith(only)) continue;
  if (e.opaque) continue;
  if (e.schema) emitExport(e);
  else emitConst(e);
}

const allNames = [];
for (const mod of mods.values()) {
  const head = mod.path === "genui" ? ["//! The wire records of visual answers: port of the schemas in `contracts/src/genui/spec.ts`", "//! (route bodies, stored views, bus payloads). A stored `spec` and a `Place` are plain", "//! JSON here: the tool inputs, the catalog, the parsers and `validate_view` are `eos-genui`'s.", ""] : [`//! Port of \`contracts/src/${mod.path.startsWith("http") ? "http" : [...new Set(exportsList.filter((e) => e.mod === mod.path).map((e) => e.file))][0].replace(/\.ts$/, "")}.ts\`${mod.path.startsWith("http::") ? ` (${mod.path.slice(6).replace(/_/g, " ")})` : ""}.`, ""];
  const body = mod.out.join("\n");
  const uses = [];
  if (mod.usesMap || /IndexMap</.test(body)) uses.push("use indexmap::IndexMap;");
  if (/JsonSchema/.test(body)) uses.push("use schemars::JsonSchema;");
  if (/Serialize/.test(body)) uses.push("use serde::{Deserialize, Serialize};");
  if (/\bValue\b/.test(body)) uses.push("use serde_json::Value;");
  const prim = [];
  if (/\bNum\b/.test(body)) prim.push("Num");
  if (/BoolLit</.test(body)) prim.push("BoolLit");
  if (/IntLit</.test(body)) prim.push("IntLit");
  if (/"de::/.test(body)) prim.push("de");
  if (mod.lits.size) prim.push("str_lit");
  if (/"yes"/.test(body)) prim.push("yes");
  const own = [];
  if (prim.length) own.push(`use crate::primitives::{${prim.join(", ")}};`);
  const val = [];
  if (/\bIssues\b/.test(body)) val.push("Issues");
  if (/impl Validate/.test(body)) val.push("Validate");
  if (/re!\(/.test(body)) val.push("re");
  if (val.length) own.push(`use crate::validate::{${val.join(", ")}};`);
  for (const [path, names] of [...mod.imports].sort()) own.push(`use crate::${path}::{${[...names].sort().join(", ")}};`);
  const lits = [...mod.lits].map(([value, name]) => `str_lit!(pub ${name} = ${rstr(value)});`);
  const text = [...head, ...uses, ...(uses.length && own.length ? [""] : []), ...own.sort(), "", ...(lits.length ? [...lits, ""] : []), body].join("\n").replace(/\n{3,}/g, "\n\n");
  const file = join(outDir, `${mod.path.replace("::", "/")}.rs`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.trimEnd() + "\n");
  allNames.push(mod.path);
}
writeFileSync(join(outDir, "PORT_REPORT.txt"), report.join("\n") + "\n");
console.log(`modules: ${allNames.length}, notes: ${report.length}`);
console.log(allNames.sort().join(" "));
