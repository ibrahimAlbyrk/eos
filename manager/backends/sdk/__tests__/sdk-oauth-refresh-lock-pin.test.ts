import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_REFRESH_LOCK } from "../../../../infra/src/auth/ClaudeLoginRefresher.ts";

// Eos renews idle Claude sign-ins under the claude binary's own refresh lock
// (infra/src/auth/ClaudeLoginRefresher.ts) — an internal of the binary. This fails
// an SDK bump whose binary moves or drops that lock, or the refresh-token login,
// instead of sign-ins starting to drop again.
function bundledClaudeBinaries(): string[] {
  let scope = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  while (basename(scope) !== "@anthropic-ai") scope = dirname(scope);
  return readdirSync(scope)
    .filter((d) => d.startsWith("claude-agent-sdk-"))
    .flatMap((d) => ["claude", "claude.exe"].map((f) => join(scope, d, f)))
    .filter((p) => existsSync(p));
}

describe("claude binary OAuth refresh lock", () => {
  it("the bundled binary still renews under the store's refresh lock and logs in from a refresh token", (t) => {
    const binaries = bundledClaudeBinaries();
    if (!binaries.length) return t.skip("no bundled claude binary installed");
    for (const path of binaries) {
      const bin = readFileSync(path);
      assert.ok(bin.includes(`"${CLAUDE_REFRESH_LOCK}"`), `${path}: refresh lock name`);
      assert.ok(bin.includes("CLAUDE_SECURESTORAGE_CONFIG_DIR"), `${path}: store dir env`);
      assert.ok(bin.includes("CLAUDE_CODE_OAUTH_REFRESH_TOKEN"), `${path}: refresh-token login`);
    }
  });
});
