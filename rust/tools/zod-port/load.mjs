// Loads contracts/src (minus genui) and names every exported Zod schema.
// Shared by port.mjs (the one-off Rust scaffold) and vectors.mjs (the test corpus).

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const isZ = (v) => !!v && typeof v === "object" && !!v._def && typeof v.safeParse === "function";
export const T = (s) => s._def.typeName;

// http.ts is split by route area: [first line, submodule].
const HTTP_GROUPS = [
  [1, "workers"], [224, "git"], [321, "terminal"], [478, "fs"], [513, "workers"], [538, "policy"],
  [585, "config"], [754, "fs"], [781, "git"], [1052, "fs"], [1147, "symbols"], [1203, "fs"],
  [1346, "workers"], [1396, "git"], [1569, "commands"], [1588, "templates"], [1639, "pages"],
  [1730, "project_memory"], [1763, "settings"], [1787, "workers"], [1813, "questions"], [1952, "workers"],
  [1963, "rewind"], [2091, "workers"], [2104, "system"], [2131, "prompts"], [2178, "worker_definitions"],
  [2201, "workers"], [2242, "system"],
];
const RENAMED = { loop: "loops" };
const OPAQUE = new Set(["PresentInputSchema", "PresentAppInputSchema"]);

export async function load(repo) {
  const dir = resolve(repo, "contracts/src");
  // genui: only the wire records of spec.ts (route bodies, stored views). The
  // tool inputs and catalog entities inside them are eos-genui's: opaque JSON here.
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts"), "genui/spec.ts"].sort();
  const exportsList = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8").split("\n");
    const lineOf = new Map();
    text.forEach((l, i) => {
      const m = /^export (?:const|function) ([A-Za-z0-9_]+)/.exec(l);
      if (m && !lineOf.has(m[1])) lineOf.set(m[1], i + 1);
    });
    const ns = await import(pathToFileURL(join(dir, file)).href);
    const genui = file.startsWith("genui/");
    const base = genui ? "genui" : file.replace(/\.ts$/, "").replace(/-/g, "_");
    for (const [name, value] of Object.entries(ns)) {
      const line = lineOf.get(name) ?? 0;
      let mod = RENAMED[base] ?? base;
      if (file === "http.ts") {
        let sub = "workers";
        for (const [from, g] of HTTP_GROUPS) if (line >= from) sub = g;
        mod = `http::${sub}`;
      }
      if (genui && !isZ(value) && !(typeof value === "string" || typeof value === "number")) continue;
      exportsList.push({ file, mod, name, value, line, schema: isZ(value), opaque: OPAQUE.has(name) });
    }
  }
  // http.ts re-exports schemas other files define: it goes last so the defining file names them.
  const rank = (f) => (f === "http.ts" ? `~${f}` : f);
  exportsList.sort((a, b) => (a.file === b.file ? a.line - b.line : rank(a.file) < rank(b.file) ? -1 : 1));
  // First export of a schema object names it; a later export of the same object is an alias.
  const named = new Map();
  for (const e of exportsList) {
    if (!e.schema) continue;
    e.rust = e.name.replace(/Schema$/, "");
    if (named.has(e.value)) e.aliasOf = named.get(e.value);
    else named.set(e.value, e);
  }
  const catalog = await import(pathToFileURL(join(dir, "genui/catalog.ts")).href);
  named.set(catalog.PlaceSchema, { opaque: true, rust: "Place", mod: "genui" });
  return { dir, exportsList, named };
}

// The options of a union, whichever way Zod stores them.
export const optionsOf = (s) => (Array.isArray(s._def.options) ? s._def.options : [...s._def.options.values()]);

// Peels optional / nullable / default wrappers off a field, as Zod applies them:
// an outer optional wins over an inner default (undefined stays undefined).
export function unwrap(s, named, self) {
  let optional = false, nullable = false, def;
  for (;;) {
    if (s !== self && named.has(s)) break;
    const t = T(s);
    if (t === "ZodOptional") { if (!def) optional = true; s = s._def.innerType; }
    else if (t === "ZodNullable") { nullable = true; s = s._def.innerType; }
    else if (t === "ZodDefault") { if (!optional && !def) def = { value: s._def.defaultValue() }; s = s._def.innerType; }
    else if (t === "ZodBranded" || t === "ZodReadonly") s = s._def.type ?? s._def.innerType;
    else break;
  }
  return { core: s, optional, nullable, def };
}
