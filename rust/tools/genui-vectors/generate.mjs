#!/usr/bin/env node
// Regenerates rust/fixtures/genui: the vectors the Rust port of contracts/src/genui
// is held to. Each vector is an input and what the TypeScript returned for it.
//
//   node rust/tools/genui-vectors/generate.mjs            write the corpus
//   node rust/tools/genui-vectors/generate.mjs --check    fail when it would change
//   node …/generate.mjs --explain <file> <n>              print vector n in full
//
// Needs Node ≥ 23.6 (runs the .ts sources directly) and `npm ci` in contracts/.
// The corpus records a hash of the TypeScript sources, the tests and this tool;
// `cargo test -p eos-genui` fails when that hash no longer matches (run this again).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPOSITES, canon, unsupported } from "./lib/canon.mjs";
import { clone, fnv1a64, wellFormed } from "./lib/encode.mjs";
import { Corpus } from "./lib/pack.mjs";
import { applyOps } from "./lib/ops.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const GENUI = path.join(REPO, "contracts/src/genui");
const TESTS = path.join(REPO, "contracts/src/__tests__");
const OUT = path.join(REPO, "rust/fixtures/genui");

// The same list, in the same order, as tests/corpus.rs hashes.
function sourceHash() {
  const dirs = [
    ["contracts/src/genui", (f) => f.endsWith(".ts")],
    ["contracts/src/__tests__", (f) => /^genui-.*\.test\.ts$/.test(f)],
    ["contracts/src/__tests__/fixtures/genui", () => true],
    ["rust/tools/genui-vectors", (f) => f.endsWith(".mjs")],
    ["rust/tools/genui-vectors/lib", (f) => f.endsWith(".mjs")],
    ["rust/tools/genui-vectors/families", (f) => f.endsWith(".mjs")],
  ];
  let all = "";
  for (const [dir, keep] of dirs) {
    for (const file of readdirSync(path.join(REPO, dir)).filter(keep).sort()) {
      all += `${dir}/${file}\n${fnv1a64(readFileSync(path.join(REPO, dir, file), "utf8"))}\n`;
    }
  }
  return fnv1a64(all);
}

async function loadModules() {
  const mods = {};
  for (const name of ["catalog", "spec", "markup", "partial-json", "expr", "attrs", "prompt"]) {
    mods[name === "partial-json" ? "json" : name] = await import(pathToFileURL(path.join(GENUI, `${name}.ts`)).href);
  }
  return mods;
}

function fixture(name) {
  return JSON.parse(readFileSync(path.join(TESTS, "fixtures/genui", `${name}.json`), "utf8"));
}

async function build() {
  const mods = await loadModules();
  const functions = { ...mods.markup, ...mods.json, ...mods.expr, ...mods.attrs, ...mods.catalog, ...mods.spec };
  const corpus = new Corpus("g");
  const bases = {};
  const scopes = {};

  // What a family calls to record one call of the real implementation.
  const api = {
    mods,
    fixture,
    call(family, fn, ...args) {
      const why = unsupported(fn, args);
      if (why) throw new Error(`${family}: ${fn} cannot be a vector (${why})`);
      const stored = args.map(clone);
      const result = COMPOSITES[fn] ? COMPOSITES[fn](functions, scopes, ...args) : canon(mods, fn, functions[fn](...args));
      const out = wellFormed(result);
      corpus.add(family, fn, stored, out);
      return out;
    },
    // A named input shared by composite vectors (see lib/canon.mjs).
    scope(name, value) {
      scopes[name] = clone(value);
    },
    // validateView over bases[base] with edits (see lib/ops.mjs).
    edit(family, base, ops) {
      const out = wellFormed(mods.catalog.validateView(applyOps(clone(bases[base]), ops)));
      corpus.addEdit(family, base, ops, out);
      return out;
    },
    base(name, input) {
      bases[name] = clone(input);
    },
  };

  for (const file of readdirSync(path.join(HERE, "families")).filter((f) => f.endsWith(".mjs")).sort()) {
    const family = await import(pathToFileURL(path.join(HERE, "families", file)).href);
    family.default(api);
  }

  // Every call the TypeScript tests make, recorded in a child process (the test
  // runner owns that process's lifetime).
  const tmp = mkdtempSync(path.join(tmpdir(), "genui-vectors-"));
  const captured = path.join(tmp, "tests.json");
  let tests;
  try {
    execFileSync(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "--capture", captured], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "en_US.UTF-8", TZ: "UTC" },
    });
    tests = JSON.parse(readFileSync(captured, "utf8"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const families = corpus.pack();
  families.set("tests", tests.vectors);
  const docs = { ...tests.docs, ...Object.fromEntries([...corpus.docs].map(([text, id]) => [id, text])) };
  const skipped = { ...tests.skipped };
  for (const [why, n] of Object.entries(corpus.skipped)) skipped[why] = (skipped[why] ?? 0) + n;

  const files = new Map();
  const lines = (list) => `[\n${list.map((v) => JSON.stringify(v)).join(",\n")}\n]\n`;
  const counts = {};
  for (const [family, vectors] of [...families].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files.set(`${family}.json`, lines(vectors));
    // A sweep is one vector per prefix it covers (gaps are prefixes that split a character).
    counts[family] = vectors.reduce((n, v) => n + (v.h8 ? v.h8.match(/.{8}/g).filter((h) => h !== "--------").length : 1), 0);
  }
  files.set("docs.json", `${JSON.stringify(docs, null, 1)}\n`);
  files.set("bases.json", `${JSON.stringify(bases, null, 1)}\n`);
  files.set("scopes.json", `${JSON.stringify(scopes, null, 1)}\n`);
  files.set("catalog.json", `${JSON.stringify(catalogDump(mods), null, 1)}\n`);
  files.set("catalog-prompt.txt", mods.prompt.catalogPrompt());
  const manifest = {
    about: "Generated by rust/tools/genui-vectors/generate.mjs from contracts/src/genui — do not edit.",
    sources: sourceHash(),
    node: process.version,
    zod: JSON.parse(readFileSync(path.join(REPO, "contracts/node_modules/zod/package.json"), "utf8")).version,
    vectors: counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    notRecorded: skipped,
  };
  files.set("manifest.json", `${JSON.stringify(manifest, null, 1)}\n`);
  return { files, manifest };
}

// The catalog tables as data, for the Rust tables to be compared with.
function catalogDump(mods) {
  const c = mods.catalog;
  return {
    tones: c.GENUI_TONES,
    icons: c.GENUI_ICONS,
    limits: c.GENUI_LIMITS,
    entityTypes: c.ENTITY_TYPES,
    actionKinds: c.ACTION_KINDS,
    presentKeys: c.PRESENT_KEYS,
    groups: c.COMPONENT_GROUPS,
    globalAttrs: Object.entries(c.GLOBAL_ATTRS),
    collectionAttrs: Object.entries(c.COLLECTION_ATTRS),
    components: c.COMPONENT_NAMES.map((name) => {
      const def = c.COMPONENTS[name];
      return { name, group: def.group, doc: def.doc, attrs: Object.entries(def.attrs), children: def.children, collection: def.collection ?? null, needs: def.needs ?? [], allAttrs: Object.keys(c.componentAttrs(name)) };
    }),
    exprFunctions: mods.expr.EXPR_FUNCTIONS,
    exprRoots: mods.expr.EXPR_ROOTS,
    exprMaxLength: mods.expr.EXPR_MAX_LENGTH,
    rawTextTags: [...mods.markup.RAW_TEXT_TAGS],
    offText: mods.spec.GENUI_OFF_TEXT,
  };
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "--capture") {
    const { capture } = await import("./lib/capture.mjs");
    return capture(GENUI, TESTS, rest[0]);
  }
  if (!existsSync(path.join(REPO, "contracts/node_modules/zod"))) throw new Error("run `npm ci` in contracts/ first");
  // Filters lower-case with the process locale (toLocaleLowerCase); the Rust port has
  // none. A Turkish or Lithuanian locale would record what only that locale does.
  if ("I".toLocaleLowerCase() !== "i" || "İ".toLocaleLowerCase() !== "i̇") throw new Error("run with LC_ALL=en_US.UTF-8: the corpus must not depend on this machine's locale");
  if (mode === "--explain") return explain(rest[0], Number(rest[1]));
  const { files, manifest } = await build();
  if (mode === "--check") {
    const stale = [...files].filter(([name, text]) => !existsSync(path.join(OUT, name)) || readFileSync(path.join(OUT, name), "utf8") !== text).map(([name]) => name);
    if (stale.length) {
      console.error(`rust/fixtures/genui is stale: ${stale.join(", ")} — run node rust/tools/genui-vectors/generate.mjs`);
      process.exit(1);
    }
    console.log(`rust/fixtures/genui is current (${manifest.total} vectors)`);
    return;
  }
  mkdirSync(OUT, { recursive: true });
  for (const name of readdirSync(OUT)) if (!files.has(name)) rmSync(path.join(OUT, name));
  for (const [name, text] of files) writeFileSync(path.join(OUT, name), text);
  console.log(`wrote ${files.size} files, ${manifest.total} vectors`, manifest.vectors);
  if (Object.keys(manifest.notRecorded).length) console.log("not recorded:", manifest.notRecorded);
}

// Prints one stored vector with its input and the full TypeScript result (hashed
// vectors keep only a digest on disk).
async function explain(file, n) {
  const { decode } = await import("./lib/ops.mjs");
  const mods = await loadModules();
  const functions = { ...mods.markup, ...mods.json, ...mods.expr, ...mods.attrs, ...mods.catalog, ...mods.spec };
  const vectors = JSON.parse(readFileSync(path.join(OUT, file), "utf8"));
  const docs = JSON.parse(readFileSync(path.join(OUT, "docs.json"), "utf8"));
  const bases = JSON.parse(readFileSync(path.join(OUT, "bases.json"), "utf8"));
  const scopes = JSON.parse(readFileSync(path.join(OUT, "scopes.json"), "utf8"));
  const v = vectors[n];
  let args;
  if (v.base !== undefined) args = [applyOps(clone(bases[v.base]), decode(v.ops))];
  else if (v.doc !== undefined) {
    const cut = Number(process.argv[5] ?? v.from);
    args = [docs[v.doc].slice(0, cut), ...decode(v.rest)];
  } else args = decode(v.args);
  console.log(JSON.stringify({ fn: v.fn, args }, null, 1));
  const result = COMPOSITES[v.fn] ? COMPOSITES[v.fn](functions, scopes, ...args) : canon(mods, v.fn, functions[v.fn](...args));
  console.log(JSON.stringify(wellFormed(result)));
}

await main();
