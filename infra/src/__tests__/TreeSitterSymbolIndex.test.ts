import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeSitterSymbolIndex } from "../symbols/TreeSitterSymbolIndex.ts";

// A non-git fixture dir → listCandidateFiles falls back to the depth-5 walk, so
// this also exercises the shared candidate helper. Covers the priority set
// (TS, Python, Go) end to end: parse → tags query → definitions/references/search.
describe("TreeSitterSymbolIndex", () => {
  let root: string;
  let index: TreeSitterSymbolIndex;
  const alpha = () => join(root, "alpha.ts");
  const delta = () => join(root, "sub", "delta.ts");

  before(() => {
    root = mkdtempSync(join(tmpdir(), "eos-sym-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(
      alpha(),
      "export function classifyReport(x: number) { return x }\n" +
        "export class Widget { render() { return classifyReport(1) } }\n" +
        "function helper() { return 1 }\n",
    );
    writeFileSync(join(root, "beta.py"), "class Foo:\n    def bar(self):\n        classifyReport()\n");
    writeFileSync(join(root, "gamma.go"), "package p\nfunc Serve() int { return 0 }\n");
    writeFileSync(delta(), "function helper() { return 2 }\n");
    index = new TreeSitterSymbolIndex({ maxResidentRoots: 2 });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("definitions() returns the name-matched definition with 1-based position", async () => {
    const defs = await index.definitions(root, "classifyReport");
    assert.equal(defs.length, 1);
    assert.equal(defs[0].role, "definition");
    assert.equal(defs[0].kind, "function");
    assert.equal(defs[0].path, alpha());
    assert.equal(defs[0].line, 1);
    assert.ok(defs[0].column >= 1);
  });

  it("definitions() finds symbols across languages (python, go)", async () => {
    assert.equal((await index.definitions(root, "Foo"))[0]?.kind, "class");
    assert.equal((await index.definitions(root, "bar"))[0]?.path, join(root, "beta.py"));
    assert.equal((await index.definitions(root, "Serve"))[0]?.path, join(root, "gamma.go"));
  });

  it("references() returns the full occurrence list (def + refs)", async () => {
    const refs = await index.references(root, "classifyReport");
    // 1 definition (alpha.ts:1) + a call in alpha.ts:2 + a call in beta.py:3.
    assert.ok(refs.length >= 3, `expected >=3 occurrences, got ${refs.length}`);
    assert.ok(refs.some((o) => o.role === "definition"));
    assert.ok(refs.some((o) => o.role === "reference"));
  });

  it("definitionsInFile() returns only that file's definitions, no references, no cross-file", async () => {
    const defs = await index.definitionsInFile(root, alpha());
    assert.ok(defs.every((o) => o.role === "definition"), "all occurrences are definitions");
    assert.ok(defs.every((o) => o.path === alpha()), "all occurrences are from the queried file");
    const names = defs.map((o) => o.name);
    assert.ok(names.includes("classifyReport"), "includes the function definition");
    assert.ok(names.includes("Widget"), "includes the class definition");
    // Foo is defined only in beta.py — a single-file enumeration must not leak it.
    assert.ok(!names.includes("Foo"), "excludes cross-file definitions");
  });

  it("searchSymbols() ranks by name match (exact/prefix/substring)", async () => {
    const hits = await index.searchSymbols(root, "classify", 10);
    assert.ok(hits.some((o) => o.name === "classifyReport"));
    const widget = await index.searchSymbols(root, "widget", 10);
    assert.equal(widget[0]?.name, "Widget");
  });

  it("definitions(fromPath) ranks a same-file definition first", async () => {
    const fromDelta = await index.definitions(root, "helper", delta());
    assert.equal(fromDelta[0].path, delta());
    const fromAlpha = await index.definitions(root, "helper", alpha());
    assert.equal(fromAlpha[0].path, alpha());
  });

  it("invalidate() re-parses a changed file and swaps its occurrences", async () => {
    writeFileSync(alpha(), "export function classifyThing() { return 0 }\n");
    await index.invalidate(root, [alpha()]);
    assert.equal((await index.definitions(root, "classifyReport")).length, 0);
    assert.equal((await index.definitions(root, "classifyThing"))[0]?.path, alpha());
    // Widget was in the old alpha.ts and is gone after the swap.
    assert.equal((await index.definitions(root, "Widget")).length, 0);
  });

  it("release() drops the resident index", async () => {
    await index.ensureIndexed(root);
    assert.ok(index.residentRoots().includes(root));
    index.release(root);
    assert.ok(!index.residentRoots().includes(root));
    // Re-query rebuilds from disk (Serve still defined in gamma.go).
    assert.equal((await index.definitions(root, "Serve"))[0]?.path, join(root, "gamma.go"));
  });
});

describe("TreeSitterSymbolIndex lineText and exclusions", () => {
  let root: string;
  let index: TreeSitterSymbolIndex;
  const long = `export function longName() { return "${"x".repeat(600)}" }`;
  const filler = (lines: number) => "let filler = 'abcdefghijklmnopqrstuvwxyz0123456789';\n".repeat(lines);

  before(() => {
    root = mkdtempSync(join(tmpdir(), "eos-sym-x-"));
    for (const d of ["vendor/lib", "Third_Party", "vendorish", "big"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "app.ts"), `\uFEFFexport function kept() {}\r\n  kept()\n${long}\n`);
    writeFileSync(join(root, "vendor", "lib", "dep.js"), "function vendored() {}\n");
    writeFileSync(join(root, "Third_Party", "dep.ts"), "function thirdParty() {}\n");
    writeFileSync(join(root, "vendorish", "own.ts"), "function vendorishOwn() {}\n");
    writeFileSync(join(root, "lib.min.js"), "function minName() {}\n");
    writeFileSync(join(root, "bundle.js"), `function minified() {}${";".repeat(1000)}\n`);
    writeFileSync(join(root, "big", "huge.ts"), `function huge() {}\n${filler(10_500)}`); // 525 KB
    writeFileSync(join(root, "big", "ok.ts"), `function nearCap() {}\n${filler(9_500)}`); // 475 KB
    index = new TreeSitterSymbolIndex();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns each row's source line (BOM and CR kept, cut at 500 chars)", async () => {
    const refs = await index.references(root, "kept");
    assert.deepEqual(
      refs.map((o) => [o.role, o.line, o.lineText]),
      [["definition", 1, "\uFEFFexport function kept() {}\r"], ["reference", 2, "  kept()"]],
    );
    const [def] = await index.definitions(root, "longName");
    assert.equal(def.lineText, long.slice(0, 500));
    assert.equal((await index.searchSymbols(root, "kept", 5))[0].lineText, "\uFEFFexport function kept() {}\r");
    assert.equal((await index.definitionsInFile(root, join(root, "app.ts")))[0].lineText, "\uFEFFexport function kept() {}\r");
  });

  it("leaves vendored, minified and >512 KB files out", async () => {
    for (const name of ["vendored", "thirdParty", "minName", "minified", "huge"]) {
      assert.deepEqual(await index.references(root, name), [], name);
    }
    assert.equal((await index.definitions(root, "vendorishOwn")).length, 1);
    assert.equal((await index.definitions(root, "nearCap")).length, 1);
    assert.deepEqual(await index.definitionsInFile(root, join(root, "vendor", "lib", "dep.js")), []);
  });
});

describe("TreeSitterSymbolIndex during a build", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "eos-sym-b-"));
    writeFileSync(join(root, "a.ts"), "function first() {}\n");
    writeFileSync(join(root, "b.ts"), "function second() {}\n");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The first build's file listing waits for open(); `listing` resolves once it started.
  function gatedIndex() {
    let open!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const listing = new Promise<void>((r) => (started = r));
    let lists = 0;
    const index = new TreeSitterSymbolIndex({
      listFiles: async () => {
        if (++lists === 1) {
          started();
          await gate;
        }
        return ["a.ts"];
      },
    });
    return { index, open, listing, lists: () => lists };
  }

  it("applies an invalidate() that arrives mid-build once the build lands", async () => {
    const { index, open, listing } = gatedIndex();
    const built = index.ensureIndexed(root);
    await listing;
    assert.deepEqual(index.residentRoots(), [root]);
    const changed = index.invalidate(root, [join(root, "b.ts")]);
    open();
    await Promise.all([built, changed]);
    assert.equal((await index.definitions(root, "first")).length, 1);
    assert.equal((await index.definitions(root, "second")).length, 1);
  });

  it("keeps a root dirty when markDirty() arrives mid-build", async () => {
    const { index, open, listing, lists } = gatedIndex();
    const built = index.ensureIndexed(root);
    await listing;
    index.markDirty(root);
    open();
    await built;
    await index.ensureIndexed(root);
    assert.equal(lists(), 2);
  });
});
