import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claudeStoreService, createSubscriptionAuthResolver } from "../auth/SubscriptionAuthResolver.ts";

describe("SubscriptionAuthResolver", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const k of Object.keys(saved)) delete saved[k];
  });

  it("subscription -> an Eos-store login resolves oauth without exporting its token", async () => {
    const readLogin = () => ({ present: true, token: "sk-ant-oat01-store-fresh" });
    const r = await createSubscriptionAuthResolver({ readLogin }).resolve(undefined);
    assert.deepEqual(r, { scheme: "oauth" });
  });

  it("subscription -> none without an Eos login, even with CLAUDE_CODE_OAUTH_TOKEN set", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-outside-eos");
    const readLogin = () => ({ present: false, token: null });
    const r = await createSubscriptionAuthResolver({ readLogin }).resolve(undefined);
    assert.deepEqual(r, { scheme: "none" });
  });

  it("claudeStoreService — the default item, or one suffixed by the store dir's hash", () => {
    assert.equal(claudeStoreService(), "Claude Code-credentials");
    assert.match(claudeStoreService("/Users/x/.eos/accounts/claude"), /^Claude Code-credentials-[0-9a-f]{8}$/);
    assert.notEqual(claudeStoreService("/a"), claudeStoreService("/b"));
  });

  it("env -> apikey from the referenced env var", async () => {
    setEnv("EOS_TEST_PROVIDER_KEY", "sk-deepseek-123");
    const r = await createSubscriptionAuthResolver().resolve({ kind: "env", ref: "EOS_TEST_PROVIDER_KEY" });
    assert.deepEqual(r, { scheme: "apikey", apiKey: "sk-deepseek-123" });
  });

  it("env -> none when the referenced var is absent", async () => {
    setEnv("EOS_TEST_ABSENT_KEY", undefined);
    const r = await createSubscriptionAuthResolver().resolve({ kind: "env", ref: "EOS_TEST_ABSENT_KEY" });
    assert.deepEqual(r, { scheme: "none" });
  });
});
