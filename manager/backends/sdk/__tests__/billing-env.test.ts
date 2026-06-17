import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildBillingGuardEnv } from "../billing-env.ts";

describe("buildBillingGuardEnv — SDK child billing guard", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });

  it("strips ANTHROPIC_API_KEY and injects the OAuth token + ENABLE_TOOL_SEARCH + EOS triplet", () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const env = buildBillingGuardEnv({
      auth: { scheme: "oauth", token: "oat01-tok" },
      workerId: "w-1",
      daemonUrl: "http://127.0.0.1:7400",
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat01-tok");
    assert.equal(env.ENABLE_TOOL_SEARCH, "false");
    assert.equal(env.EOS_SPAWNED, "1");
    assert.equal(env.EOS_WORKER_ID, "w-1");
    assert.equal(env.EOS_DAEMON_URL, "http://127.0.0.1:7400");
  });

  it("injects no token when the auth scheme is not oauth", () => {
    const env = buildBillingGuardEnv({ auth: { scheme: "none" }, workerId: "w-2", daemonUrl: "http://x" });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  });
});
