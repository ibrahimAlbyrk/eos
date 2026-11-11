// What Node does with each pattern on each input, the way Eos uses them:
// `new RegExp(pattern)` (no flags), `.test()`, and for rewrite rules
// `input.replace(re, rewriteTo)`. Input { patterns, inputs } → output
// [{ pattern, error | results: [{ index, match, groups, named, replaced? }] }].
// index is in UTF-16 code units; a lone surrogate in a match is kept as \uXXXX by JSON.
import { readFileSync, writeFileSync } from "node:fs";

const [inFile, outFile] = process.argv.slice(2);
const { patterns, inputs } = JSON.parse(readFileSync(inFile, "utf8")) as { patterns: Array<{ pattern: string; rewriteTo?: string }>; inputs?: string[] };
const texts: string[] = inputs ?? JSON.parse(readFileSync(new URL("../fixtures/regex/probes.json", import.meta.url), "utf8")).inputs;

const out = patterns.map(({ pattern, rewriteTo }) => {
  let re: RegExp;
  try { re = new RegExp(pattern); } catch (e) { return { pattern, error: (e as Error).name }; }
  const results = texts.map((text) => {
    const m = re.exec(text);
    const replaced = rewriteTo === undefined ? undefined : text.replace(re, rewriteTo);
    if (!m) return { index: -1, ...(replaced === undefined ? {} : { replaced }) };
    return {
      index: m.index, match: m[0], groups: m.slice(1).map((g) => g ?? null),
      ...(m.groups ? { named: Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, v ?? null])) } : {}),
      ...(replaced === undefined ? {} : { replaced }),
    };
  });
  return { pattern, ...(rewriteTo === undefined ? {} : { rewriteTo }), results };
});
writeFileSync(outFile, JSON.stringify(out) + "\n");
console.log(JSON.stringify({ patterns: out.length, syntaxErrors: out.filter((o) => "error" in o).length, inputs: texts.length }));
