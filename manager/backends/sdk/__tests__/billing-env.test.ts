import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildBillingGuardEnv, anthropicCredentialEnv } from "../billing-env.ts";

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

  it("config-provided creds are injected into the child env; the apiKey survives the strip", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ambient-should-not-leak";
    const env = buildBillingGuardEnv({
      auth: { scheme: "none" },
      anthropic: { apiKey: "sk-configured" },
      workerId: "w-3",
      daemonUrl: "http://x",
    });
    // The ambient key is stripped, but the operator-configured one is re-injected.
    assert.equal(env.ANTHROPIC_API_KEY, "sk-configured");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  });

  it("a config authToken overrides the resolved subscription OAuth token", () => {
    const env = buildBillingGuardEnv({
      auth: { scheme: "oauth", token: "oat01-resolved" },
      anthropic: { authToken: "oat01-configured" },
      workerId: "w-4",
      daemonUrl: "http://x",
    });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oat01-configured");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});

describe("anthropicCredentialEnv — OAuth-wins priority", () => {
  it("chooses the OAuth token when BOTH are set (never emits the API key)", () => {
    const env = anthropicCredentialEnv({ apiKey: "sk-key", authToken: "oat01-tok" });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "oat01-tok" });
  });

  it("uses the API key when ONLY the API key is set", () => {
    const env = anthropicCredentialEnv({ apiKey: "sk-key" });
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "sk-key" });
  });

  it("uses the OAuth token when ONLY the token is set", () => {
    const env = anthropicCredentialEnv({ authToken: "oat01-tok" });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "oat01-tok" });
  });

  it("emits nothing when neither is set (and treats blank/whitespace as unset)", () => {
    assert.deepEqual(anthropicCredentialEnv({}), {});
    assert.deepEqual(anthropicCredentialEnv({ apiKey: "  ", authToken: "\t" }), {});
  });
});
