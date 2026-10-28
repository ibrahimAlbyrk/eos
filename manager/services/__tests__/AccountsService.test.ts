import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AccountsService, type AccountsServiceDeps } from "../accounts/AccountsService.ts";
import type { ProviderPreset } from "../../shared/provider-presets.ts";
import type { BackendProfile } from "../../../contracts/src/backend.ts";
import { PlanLoginService } from "../../../core/src/services/PlanLoginService.ts";
import { PlanLimitLedger } from "../../../core/src/services/PlanLimitLedger.ts";
import { EMPTY_PLAN_LOGINS, type PlanLoginRecord, type PlanLoginRegistry } from "../../../core/src/domain/plan-logins.ts";

const reader = (reg: PlanLoginRegistry) => new PlanLoginService({
  store: { load: () => reg, save: () => {} },
  dirs: { create: () => "", discard: () => {}, trash: () => {} },
  clock: { now: () => 0 },
  newId: () => "x",
});

const NOW = Date.UTC(2026, 9, 28, 12);

const record = (id: string, email?: string): PlanLoginRecord =>
  ({ id, provider: "anthropic", label: email ?? id, ...(email ? { email } : {}), storeDir: `/s/${id}`, createdAt: "2026-01-01T00:00:00.000Z" });

const preset = (id: string, label: string): ProviderPreset =>
  ({ id, label, authRef: `eos-${id}` }) as unknown as ProviderPreset;

function deps(over: Partial<AccountsServiceDeps> & { anthropic?: { apiKey?: string; authToken?: string }; backends?: Record<string, BackendProfile> } = {}) {
  let probes = 0;
  const d: AccountsServiceDeps = {
    getConfig: () => ({ anthropic: over.anthropic ?? {}, backends: over.backends ?? {} }),
    claudeLogins: reader(EMPTY_PLAN_LOGINS),
    claudeLimits: new PlanLimitLedger({ now: () => NOW }),
    readClaudeLogin: () => ({ present: false, token: null }),
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

  it("an Eos-store login is signed in, with its plan — before a legacy token", async () => {
    const t = deps({
      anthropic: { authToken: "oat" },
      claudeLogins: reader({ logins: [record("a")], defaults: {} }),
      readClaudeLogin: () => ({ present: true, token: null, plan: "max" }),
    });
    const a = await claude(t.d);
    assert.deepEqual(a.subscription, { supported: true, state: "signed_in", source: "eos", plan: "max" });
    assert.equal(a.route, "subscription");
    assert.equal(t.probes, 0);
  });

  it("lists every sign-in and bills the default one", async () => {
    const reg = { logins: [record("a", "me@example.com"), record("b", "me@company.com")], defaults: { anthropic: "b" } };
    const plans: Record<string, string> = { "/s/a": "max", "/s/b": "pro" };
    const a = await claude(deps({
      claudeLogins: reader(reg),
      readClaudeLogin: (dir) => ({ present: true, token: null, plan: plans[dir] }),
    }).d);
    assert.deepEqual(a.logins, [
      { id: "a", label: "me@example.com", email: "me@example.com", plan: "max", state: "signed_in" },
      { id: "b", label: "me@company.com", email: "me@company.com", plan: "pro", state: "signed_in" },
    ]);
    assert.equal(a.defaultLoginId, "b");
    assert.equal(a.subscription?.plan, "pro");
  });

  it("a default whose login is gone hands new sessions to one that still works", async () => {
    const reg = { logins: [record("a"), record("b")], defaults: { anthropic: "a" } };
    const a = await claude(deps({
      claudeLogins: reader(reg),
      readClaudeLogin: (dir) => (dir === "/s/b" ? { present: true, token: null, plan: "pro" } : { present: false, token: null }),
    }).d);
    assert.deepEqual(a.logins?.map((l) => l.state), ["signed_out", "signed_in"]);
    assert.deepEqual(a.subscription, { supported: true, state: "signed_in", source: "eos", plan: "pro" });
  });

  it("a limited sign-in shows until when; a default at its limit hands new sessions on", async () => {
    const limits = new PlanLimitLedger({ now: () => NOW });
    limits.mark("a", "limit", NOW + 3_600_000);
    const reg = { logins: [record("a"), record("b")], defaults: { anthropic: "a" } };
    const plans: Record<string, string> = { "/s/a": "max", "/s/b": "pro" };
    const a = await claude(deps({
      claudeLogins: reader(reg), claudeLimits: limits,
      readClaudeLogin: (dir) => ({ present: true, token: null, plan: plans[dir] }),
    }).d);
    assert.equal(a.logins?.[0].limitedUntil, new Date(NOW + 3_600_000).toISOString());
    assert.equal(a.subscription?.plan, "pro");
    assert.equal(a.autoSwitch, true);
  });

  it("counts the live sessions on each sign-in", async () => {
    const a = await claude(deps({
      claudeLogins: reader({ logins: [record("a"), record("b")], defaults: {} }),
      readClaudeLogin: () => ({ present: true, token: null }),
      sessionsOn: (dir) => (dir === "/s/a" ? 2 : 0),
    }).d);
    assert.deepEqual(a.logins?.map((l) => l.inUse), [2, undefined]);
  });

  it("every sign-in at its limit still bills the plan; one that stopped working shows as expired", async () => {
    const limits = new PlanLimitLedger({ now: () => NOW });
    limits.mark("a", "limit", NOW + 60_000);
    limits.mark("b", "expired");
    const a = await claude(deps({
      claudeLogins: reader({ logins: [record("a"), record("b")], defaults: {} }), claudeLimits: limits,
      readClaudeLogin: () => ({ present: true, token: null }),
    }).d);
    assert.equal(a.route, "subscription");
    assert.deepEqual(a.logins?.map((l) => l.state), ["signed_in", "expired"]);
  });

  it("sign-ins that all stopped working block — no fallback to the key", async () => {
    const a = await claude(deps({ anthropic: { apiKey: "sk" }, claudeLogins: reader({ logins: [record("a")], defaults: {} }) }).d);
    assert.equal(a.subscription?.state, "expired");
    assert.equal(a.route, "blocked");
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
      presetLogin: (p) => (p === "openai" ? { present: true, plan: "pro", source: "eos" } : null),
    });
    const [, openai] = await new AccountsService(t.d).list();
    assert.deepEqual(openai.subscription, { supported: true, state: "signed_in", source: "eos", plan: "pro" });
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
