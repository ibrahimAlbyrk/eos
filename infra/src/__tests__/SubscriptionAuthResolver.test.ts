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

  it("subscription -> live store token wins over the env fast-path", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-env-stale");
    const readStore = () => "sk-ant-oat01-store-fresh";
    const r = await createSubscriptionAuthResolver({ readStore }).resolve(undefined);
    assert.deepEqual(r, { scheme: "oauth", token: "sk-ant-oat01-store-fresh" });
  });

  it("subscription -> falls back to CLAUDE_CODE_OAUTH_TOKEN when the store is empty", async () => {
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-deterministic");
    const readStore = () => null;
    const r = await createSubscriptionAuthResolver({ readStore }).resolve(undefined);
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
