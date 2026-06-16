import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeStamp } from "../hash.ts";
import { baseExclude, managerExclude } from "../inputs.ts";

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "eos-hash-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function seed(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
}

describe("computeStamp", () => {
  it("is independent of file creation order", () => {
    const a = tmp();
    seed(a, { "b.ts": "bbb", "a.ts": "aaa", "sub/c.ts": "ccc" });
    const b = tmp();
    seed(b, { "sub/c.ts": "ccc", "a.ts": "aaa", "b.ts": "bbb" });
    assert.equal(
      computeStamp({ trees: [{ root: a, prefix: "t" }] }),
      computeStamp({ trees: [{ root: b, prefix: "t" }] }),
    );
  });

  it("changes on content edit, rename and added file", () => {
    const root = tmp();
    seed(root, { "a.ts": "aaa" });
    const spec = { trees: [{ root, prefix: "t" }] };
    const initial = computeStamp(spec);

    writeFileSync(join(root, "a.ts"), "AAA");
    const edited = computeStamp(spec);
    assert.notEqual(edited, initial);

    renameSync(join(root, "a.ts"), join(root, "b.ts"));
    const renamed = computeStamp(spec);
    assert.notEqual(renamed, edited);

    writeFileSync(join(root, "c.ts"), "ccc");
    assert.notEqual(computeStamp(spec), renamed);
  });

  it("ignores excluded paths", () => {
    const root = tmp();
    seed(root, { "src/index.ts": "code" });
    const spec = { trees: [{ root, prefix: "t", exclude: baseExclude }] };
    const before = computeStamp(spec);
    seed(root, {
      "node_modules/x/index.js": "dep",
      "src/__tests__/a.test.ts": "test",
      "src/a.test.ts": "test",
      "README.md": "docs",
      "tsconfig.json": "{}",
      ".DS_Store": "junk",
    });
    assert.equal(computeStamp(spec), before);
    seed(root, { "src/real.ts": "more" });
    assert.notEqual(computeStamp(spec), before);
  });

  it("hashes absent optional files as stable 'absent'", () => {
    const root = tmp();
    const spec = { files: [{ path: join(root, "config.json"), label: "config" }] };
    const absent = computeStamp(spec);
    assert.equal(computeStamp(spec), absent);
    writeFileSync(join(root, "config.json"), "{}");
    assert.notEqual(computeStamp(spec), absent);
  });

  it("includes extra scalars in the hash", () => {
    assert.notEqual(
      computeStamp({ extra: { node: "v22" } }),
      computeStamp({ extra: { node: "v23" } }),
    );
  });
});

describe("exclude predicates", () => {
  it("baseExclude drops artifacts, tests, docs and tsconfigs", () => {
    for (const rel of [
      "node_modules/zod/index.js",
      "src/__tests__/x.ts",
      "src/x.test.ts",
      "dist/index.js",
      "coverage/lcov.info",
      ".DS_Store",
      "public/.DS_Store",
      "README.md",
      "tsconfig.json",
      "tsconfig.build.json",
    ]) {
      assert.equal(baseExclude(rel), true, rel);
    }
    for (const rel of ["src/index.ts", "package.json", "package-lock.json", "server.ts"]) {
      assert.equal(baseExclude(rel), false, rel);
    }
  });

  it("managerExclude drops vendor/cli/bin/scripts subtrees", () => {
    for (const rel of [
      "vendor/pdfjs/build/pdf.js",
      "cli/commands/build.ts",
      "bin/eos",
      "scripts/helper.swift",
    ]) {
      assert.equal(managerExclude(rel), true, rel);
    }
    for (const rel of ["daemon.ts", "routes/health.ts", "services/TurnSettleService.ts"]) {
      assert.equal(managerExclude(rel), false, rel);
    }
  });
});
