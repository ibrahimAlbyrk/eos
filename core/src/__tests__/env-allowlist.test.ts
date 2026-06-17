import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SUBSCRIPTION_ENV_DENYLIST, scrubSubscriptionEnv, buildSubscriptionChildEnv } from "../domain/env-allowlist.ts";

describe("env-allowlist — subscription billing protection", () => {
  it("denylist covers the keys + base url that divert subscription billing", () => {
    assert.deepEqual([...SUBSCRIPTION_ENV_DENYLIST].sort(), [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    ]);
  });

  it("scrubSubscriptionEnv removes the denylisted vars and keeps the rest", () => {
    const out = scrubSubscriptionEnv({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://proxy", PATH: "/usr/bin", FOO: "bar" });
    assert.equal(out.ANTHROPIC_API_KEY, undefined);
    assert.equal(out.ANTHROPIC_BASE_URL, undefined);
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.FOO, "bar");
  });

  it("scrubSubscriptionEnv drops undefined values", () => {
    const out = scrubSubscriptionEnv({ A: undefined, B: "x" });
    assert.equal("A" in out, false);
    assert.equal(out.B, "x");
  });

  it("buildSubscriptionChildEnv also strips the parent Claude session markers", () => {
    const out = buildSubscriptionChildEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      ANTHROPIC_API_KEY: "sk-x",
      TERM: "xterm",
    });
    assert.equal(out.CLAUDECODE, undefined);
    assert.equal(out.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(out.CLAUDE_CODE_OAUTH_TOKEN, undefined); // CLAUDE_CODE_* stripped
    assert.equal(out.ANTHROPIC_API_KEY, undefined); // denylist
    assert.equal(out.TERM, "xterm");
  });
});
