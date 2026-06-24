import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Determinism guard (C5): the pure workflow runtime must take time + identity
// ONLY from the injected Clock / IdGenerator ports — never `Date.now()` /
// `Math.random()`. This test fails if either appears in core/src/workflow/, so a
// resume-breaking source of non-determinism trips the suite instead of silently
// diverging a replay. (Math.max / Math.floor etc. are fine — only `.random` is
// banned.)

const WORKFLOW_DIR = join(import.meta.dirname, "..", "workflow");
const BANNED = /\bDate\.now\s*\(|\bMath\.random\s*\(/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
}

describe("workflow determinism guard (C5)", () => {
  it("no Date.now / Math.random in core/src/workflow/", () => {
    const files: string[] = [];
    walk(WORKFLOW_DIR, files);
    assert.ok(files.length > 0, "expected workflow source files to scan");
    const violations: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (BANNED.test(line)) violations.push(`${f.slice(WORKFLOW_DIR.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(violations, [], `Non-deterministic time/random in core/src/workflow/ — inject Clock/IdGenerator instead:\n${violations.join("\n")}`);
  });
});
