import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Background subagents are detected via the canonical subagent_started /
// subagent_completed events (contracts/src/canonical.ts), never by matching
// launch-stub text. This test fails if a stub-string heuristic reappears
// anywhere in the UI source. Mirrors manager's backend-kind-literal-guard.

const BANNED = ["Async agent launched", "Spawned successfully"];
const SELF = "subagent-literal-guard.test.js"; // this file contains the literals — skip it
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".vite"]);
const EXTS = new Set([".js", ".jsx", ".ts", ".tsx"]);

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // app/ui/src

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (EXTS.has(entry.name.slice(entry.name.lastIndexOf("."))) && basename(entry.name) !== SELF) {
      out.push(join(dir, entry.name));
    }
  }
}

describe("subagent launch-stub literal guard", () => {
  it("no launch-stub string matching in app/ui/src", () => {
    const files = [];
    walk(SRC_ROOT, files);
    const violations = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (BANNED.some((b) => line.includes(b))) {
          violations.push(`${f.slice(SRC_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, `Launch-stub literal(s) found — derive background state from subagent_* events instead:\n${violations.join("\n")}`).toEqual([]);
  });
});
