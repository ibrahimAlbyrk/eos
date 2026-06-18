import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

// Open/Closed guard: every consumer must branch on a provider's BackendDescriptor
// (processModel / billing / modelSource / capabilities), never on a hardcoded kind
// string. This test fails if a `=== "claude-cli"` / `!== "claude-sdk"` style
// COMPARISON reappears anywhere in source. Adding a provider stays data-only.
//
// Intentionally NOT flagged (no comparison operator): adapter identity
// (`kind: "claude-cli"`), null-backfill defaults (`?? "claude-cli"`), the
// BackendKind enum, registry keys, and config profile data — see the design
// report docs/design/backend-descriptor-provider-metadata.md.

const SCAN_DIRS = ["contracts/src", "core/src", "infra/src", "gateway/src", "spawner", "manager", "app/ui/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".vite"]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SELF = "backend-kind-literal-guard.test.ts"; // this file contains the pattern — skip it

// A comparison operator (== === != !==) adjacent to a "claude-cli"/"claude-sdk"
// literal, in either order. A single `=` (assignment / type alias) is not matched.
const COMPARE_RE = /(?:[=!]==?)\s*["'](?:claude-cli|claude-sdk)["']|["'](?:claude-cli|claude-sdk)["']\s*(?:[=!]==?)/;

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (["contracts", "core", "manager"].every((d) => existsSync(join(dir, d)))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (EXTS.has(entry.name.slice(entry.name.lastIndexOf("."))) && basename(entry.name) !== SELF) {
      out.push(join(dir, entry.name));
    }
  }
}

describe("backend kind-literal guard (Open/Closed)", () => {
  it('no kind-literal comparisons (=== "claude-cli" / "claude-sdk") in source', () => {
    const root = findRepoRoot();
    const files: string[] = [];
    for (const d of SCAN_DIRS) {
      const abs = join(root, d);
      if (existsSync(abs)) walk(abs, files);
    }
    const violations: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (COMPARE_RE.test(line)) violations.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Hardcoded backend-kind comparison(s) found — read the provider's BackendDescriptor instead:\n${violations.join("\n")}`,
    );
  });
});
