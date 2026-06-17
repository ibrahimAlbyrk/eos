import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createSubscriptionAuthResolver } from "../auth/SubscriptionAuthResolver.ts";

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

  it("subscription -> oauth from CLAUDE_CODE_OAUTH_TOKEN (the long-lived setup-token)", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-deterministic");
    const r = await createSubscriptionAuthResolver().resolve(undefined);
    assert.deepEqual(r, { scheme: "oauth", token: "sk-ant-oat01-deterministic" });
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
