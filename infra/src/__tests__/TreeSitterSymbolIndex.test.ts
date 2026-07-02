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
