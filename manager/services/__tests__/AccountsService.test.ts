import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AccountsService, type AccountsServiceDeps } from "../accounts/AccountsService.ts";
import type { ProviderPreset } from "../../shared/provider-presets.ts";
import type { BackendProfile } from "../../../contracts/src/backend.ts";

const preset = (id: string, label: string): ProviderPreset =>
  ({ id, label, authRef: `eos-${id}` }) as unknown as ProviderPreset;

function deps(over: Partial<AccountsServiceDeps> & { anthropic?: { apiKey?: string; authToken?: string }; backends?: Record<string, BackendProfile> } = {}) {
  let probes = 0;
  const d: AccountsServiceDeps = {
    getConfig: () => ({ anthropic: over.anthropic ?? {}, backends: over.backends ?? {} }),
    readClaudeLogin: () => ({ present: false, token: null }),
    envToken: () => null,
    probe: async () => { probes++; return "valid"; },
    presets: [preset("openai", "OpenAI"), preset("xai", "xAI Grok")],
    supportsSignIn: (p) => p === "anthropic",
    ...over,
  };
  return { d, get probes() { return probes; } };
}

const claude = async (d: AccountsServiceDeps) => (await new AccountsService(d).list())[0];

describe("AccountsService — Claude", () => {
  it("an Eos sign-in bills the subscription even with an API key set", async () => {
    const a = await claude(deps({ anthropic: { authToken: "oat", apiKey: "sk-ant-1234" } }).d);
    assert.deepEqual(a.subscription, { supported: true, state: "signed_in", source: "eos" });
    assert.deepEqual(a.apiKey, { set: true, hint: "1234" });
    assert.equal(a.route, "subscription");
  });

  it("a rejected Eos token is expired and blocks — no fallback to the key", async () => {
    const a = await claude(deps({ anthropic: { authToken: "oat", apiKey: "sk" }, probe: async () => "rejected" }).d);
    assert.equal(a.subscription?.state, "expired");
    assert.equal(a.route, "blocked");
  });

  it("an unreachable API keeps the user signed in", async () => {
    const a = await claude(deps({ anthropic: { authToken: "oat" }, probe: async () => "unknown" }).d);
    assert.equal(a.subscription?.state, "signed_in");
  });

  it("falls back to the Claude Code login, with its plan", async () => {
    const a = await claude(deps({ readClaudeLogin: () => ({ present: true, token: null, plan: "max" }) }).d);
    assert.deepEqual(a.subscription, { supported: true, state: "signed_in", source: "claude-code", plan: "max" });
    assert.equal(a.route, "subscription");
  });

  it("then to the daemon's env token", async () => {
    const a = await claude(deps({ envToken: () => "oat-env" }).d);
    assert.equal(a.subscription?.source, "env");
  });

  it("signed out: the key when set, else nothing", async () => {
    assert.equal((await claude(deps({ anthropic: { apiKey: "sk" } }).d)).route, "api_key");
    assert.equal((await claude(deps().d)).route, "none");
  });

  it("caches the probe per token until invalidated", async () => {
    const t = deps({ anthropic: { authToken: "oat" } });
    const svc = new AccountsService(t.d);
    await svc.list();
    await svc.list();
    assert.equal(t.probes, 1);
    svc.invalidate();
    await svc.list();
    assert.equal(t.probes, 2);
  });
});

describe("AccountsService — presets", () => {
  it("a plan login on a preset (openai via Codex) bills the plan, the key goes on standby", async () => {
    const backends = { openai: { kind: "openai", model: "gpt", auth: { kind: "keychain", ref: "eos-openai" } } } as unknown as Record<string, BackendProfile>;
    const t = deps({
      backends,
      supportsSignIn: () => true,
      presetLogin: (p) => (p === "openai" ? { present: true, plan: "pro", source: "codex" } : null),
    });
    const [, openai] = await new AccountsService(t.d).list();
    assert.deepEqual(openai.subscription, { supported: true, state: "signed_in", source: "codex", plan: "pro" });
    assert.equal(openai.route, "subscription");
    assert.deepEqual(openai.apiKey, { set: true });
  });

  it("a preset's key is the Keychain-backed profile that references it", async () => {
    const backends = { "my-openai": { kind: "openai", model: "gpt", auth: { kind: "keychain", ref: "eos-openai" } } } as unknown as Record<string, BackendProfile>;
    const [, openai, xai] = await new AccountsService(deps({ backends }).d).list();
    assert.deepEqual(openai, {
      id: "openai", label: "OpenAI",
      subscription: { supported: false, state: "signed_out" },
      apiKey: { set: true }, route: "api_key", profile: "my-openai",
    });
    assert.deepEqual(xai, { id: "xai", label: "xAI Grok", subscription: null, apiKey: { set: false }, route: "none" });
  });
});
