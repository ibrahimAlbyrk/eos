// One platform seam: process.platform is read only where the per-system
// adapters are chosen — infra/src/platform for the daemon, app/src/main/platform
// for the desktop shell. Everything else asks those what the system can do.
// Build tooling and the macOS-only dev CLI (manager/cli, manager/builder) sit
// outside the seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCANNED = ["contracts/src", "core/src", "infra/src", "manager", "spawner", "gateway", "app/src", "app/ui/src"];
const ALLOWED = ["infra/src/platform/", "app/src/main/platform/", "manager/cli/", "manager/cli.ts", "manager/builder/"];
const SKIPPED_DIRS = new Set(["node_modules", "vendor", "dist", "__tests__"]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIPPED_DIRS.has(e.name) && !e.name.startsWith(".")) yield* sources(join(dir, e.name));
    } else if (SOURCE.test(e.name) && !/\.test\./.test(e.name)) {
      yield join(dir, e.name);
    }
  }
}

test("process.platform is read only inside the platform seams", () => {
  const offenders: string[] = [];
  for (const top of SCANNED) {
    for (const file of sources(join(ROOT, top))) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (ALLOWED.some((a) => rel.startsWith(a))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/\bprocess\.platform\b/.test(line.replace(/\/\/.*$/, ""))) offenders.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], "read the host platform (infra/src/platform or app/src/main/platform) instead");
});
