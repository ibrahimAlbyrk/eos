import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildBillingGuardEnv, anthropicCredentialEnv, hasClaudeCredential } from "../billing-env.ts";

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

  it("switches the binary's auto-compaction off only when asked", () => {
    const base = { auth: { scheme: "none" } as const, workerId: "w", daemonUrl: "http://x" };
    assert.equal(buildBillingGuardEnv({ ...base, disableAutoCompact: true }).DISABLE_AUTO_COMPACT, "1");
    assert.equal(buildBillingGuardEnv(base).DISABLE_AUTO_COMPACT, undefined);
  });

  it("a focused session gets the Artifact tool and keeps tool search on", () => {
    const base = { auth: { scheme: "none" } as const, workerId: "w", daemonUrl: "http://x" };
    const focused = buildBillingGuardEnv({ ...base, fullSurface: true });
    assert.equal(focused.CLAUDE_CODE_ARTIFACT, "1");
    assert.equal(focused.ENABLE_TOOL_SEARCH, undefined);
    assert.equal(buildBillingGuardEnv(base).CLAUDE_CODE_ARTIFACT, undefined);
  });

  it("points the child at the Eos credential store, signed in or not", () => {
    const base = { workerId: "w", daemonUrl: "http://x", claudeStore: "/eos/accounts/claude" };
    assert.equal(buildBillingGuardEnv({ ...base, auth: { scheme: "oauth" } }).CLAUDE_SECURESTORAGE_CONFIG_DIR, "/eos/accounts/claude");
    assert.equal(buildBillingGuardEnv({ ...base, auth: { scheme: "none" } }).CLAUDE_SECURESTORAGE_CONFIG_DIR, "/eos/accounts/claude");
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

  it("a resolved Claude login beats a configured API key (signed in → subscription)", () => {
    const env = anthropicCredentialEnv({ apiKey: "sk-key" }, { scheme: "oauth", token: "oat01-login" });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "oat01-login" });
  });

  it("a refreshable login (oauth, no token) exports nothing — never the API key", () => {
    assert.deepEqual(anthropicCredentialEnv({ apiKey: "sk-key" }, { scheme: "oauth" }), {});
  });
});

describe("hasClaudeCredential", () => {
  it("counts an Eos-only sign-in or key even when the resolver finds nothing", () => {
    assert.equal(hasClaudeCredential({ authToken: "oat01" }, { scheme: "none" }), true);
    assert.equal(hasClaudeCredential({ apiKey: "sk" }, { scheme: "none" }), true);
    assert.equal(hasClaudeCredential({}, { scheme: "oauth" }), true);
    assert.equal(hasClaudeCredential({}, { scheme: "none" }), false);
  });
});
