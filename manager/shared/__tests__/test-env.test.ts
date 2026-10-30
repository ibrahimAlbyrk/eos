import { test } from "node:test";
import assert from "node:assert/strict";

// Guards the test script's `--import ../scripts/test-env.mjs`: run from inside an
// Eos session without it, a leaked EOS_DAEMON_SOCK sends fetch-mocked requests
// to the live daemon.
test("no Eos session variables reach the tests", () => {
  const leaked = Object.keys(process.env).filter((k) => k.startsWith("EOS_") || k === "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual(leaked, []);
});
