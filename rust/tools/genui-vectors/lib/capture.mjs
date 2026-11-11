// Runs the TypeScript test files with the genui modules wrapped, so every call a
// test makes to a recorded function becomes a vector: its arguments and what the
// implementation returned. Calls the implementation makes to itself are not
// recorded (only imports from test files are redirected to the wrappers).

import { registerHooks } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { RECORDED, canon, unsupported } from "./canon.mjs";
import { clone, wellFormed } from "./encode.mjs";
import { Corpus } from "./pack.mjs";

const MODULES = ["catalog", "spec", "markup", "partial-json", "expr", "attrs", "prompt"];
const SHIM = "genui-shim:";

export async function capture(genuiDir, testsDir, outFile) {
  const genuiUrl = pathToFileURL(genuiDir).href + "/";
  const real = {};
  for (const name of MODULES) real[name] = await import(`${genuiUrl}${name}.ts`);
  const mods = { markup: real.markup, expr: real.expr };

  const corpus = new Corpus("t");
  globalThis.__genuiWrap = (fn, impl) => {
    if (typeof impl !== "function" || !RECORDED.has(fn)) return impl;
    return (...args) => {
      const why = unsupported(fn, args);
      const stored = why ? null : args.map(clone);
      const result = impl(...args);
      if (!stored) corpus.skip(why);
      else corpus.add("tests", fn, stored, wellFormed(canon(mods, fn, result)));
      return result;
    };
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const fromTest = context.parentURL?.includes("/__tests__/");
      if (fromTest && resolved.url.startsWith(genuiUrl)) {
        return { url: SHIM + path.basename(resolved.url, ".ts"), shortCircuit: true, format: "module" };
      }
      return resolved;
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SHIM)) return nextLoad(url, context);
      const name = url.slice(SHIM.length);
      const lines = [`import * as real from ${JSON.stringify(`${genuiUrl}${name}.ts`)};`];
      for (const key of Object.keys(real[name])) lines.push(`export const ${key} = globalThis.__genuiWrap(${JSON.stringify(key)}, real.${key});`);
      return { format: "module", shortCircuit: true, source: lines.join("\n") };
    },
  });

  process.on("exit", () => {
    const vectors = corpus.pack().get("tests") ?? [];
    writeFileSync(outFile, JSON.stringify({ vectors, docs: Object.fromEntries([...corpus.docs].map(([text, id]) => [id, text])), skipped: corpus.skipped }));
  });
  const tests = readdirSync(testsDir).filter((f) => /^genui-.*\.test\.ts$/.test(f)).sort();
  for (const file of tests) await import(pathToFileURL(path.join(testsDir, file)).href);
}
