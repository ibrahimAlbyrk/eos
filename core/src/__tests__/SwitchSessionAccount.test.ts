import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { switchSessionAccount, type SwitchSessionAccountDeps } from "../use-cases/SwitchSessionAccount.ts";
import { continueOnApiKey } from "../use-cases/ContinueOnApiKey.ts";
import { PlanLoginService } from "../services/PlanLoginService.ts";
import { PlanLimitLedger } from "../services/PlanLimitLedger.ts";
import type { PlanLoginRecord, PlanLoginRegistry } from "../domain/plan-logins.ts";
import type { AgentBackendRegistry, AgentSession } from "../ports/AgentBackend.ts";

const NOW = Date.UTC(2026, 9, 28, 14, 12);
const login = (id: string, label: string): PlanLoginRecord =>
  ({ id, provider: "anthropic", label, storeDir: `/acc/claude-${id}`, createdAt: "t" });

function setup(opts: { reg?: Partial<PlanLoginRegistry>; signedOut?: string[]; switchOk?: boolean; capable?: boolean; apiKey?: boolean; used?: Record<string, number> } = {}) {
  const clock = { now: () => NOW };
  const reg: PlanLoginRegistry = { logins: [login("p", "Personal"), login("w", "Work"), login("x", "Spare")], defaults: { anthropic: "p" }, ...opts.reg };
  const logins = new PlanLoginService({
    store: { load: () => reg, save: () => {} },
    dirs: { create: () => "", discard: () => {}, trash: () => {} },
    clock,
    newId: () => "n",
  });
  const ledger = new PlanLimitLedger(clock);
  const calls: string[] = [];
  const rows: Array<{ type: string; payload: unknown }> = [];
  const published: Array<{ topic: string; payload: unknown }> = [];
  const session = {
    capabilities: { accountSwitch: opts.capable ?? true },
    isAlive: () => true,
    switchAccount: async (c: { storeDir?: string; apiKey?: true }) => {
      calls.push(`switch:${c.storeDir ?? "api-key"}`);
      return opts.switchOk === false ? { ok: false, reason: "boom" } : { ok: true };
    },
    sendMessage: async (text: string) => { calls.push(`send:${text}`); return { ok: true }; },
  } as unknown as AgentSession;
  const backends = { has: (k: string) => k === "claude", get: () => ({ attach: () => session }) } as unknown as AgentBackendRegistry;
  const deps: SwitchSessionAccountDeps = {
    workers: { findById: () => ({ id: "w1", name: "Builder", backend_kind: "claude" }) as never },
    events: { append: (_w, _ts, type, payload) => { rows.push({ type, payload }); return rows.length; } },
    bus: { publish: (topic, payload) => { published.push({ topic, payload }); } },
    clock,
    backends,
    logins,
    ledger,
    signedIn: (l) => !(opts.signedOut ?? []).includes(l.id),
    apiKeySet: () => opts.apiKey ?? false,
    used: (l) => opts.used?.[l.id],
    continuation: () => "continue",
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  };
  const hit = (storeDir = "/acc/claude-p", reason: "limit" | "expired" = "limit", resetsAt: number | undefined = NOW + 2 * 3_600_000) =>
    switchSessionAccount(deps, { workerId: "w1", provider: "anthropic", storeDir, reason, ...(resetsAt ? { resetsAt } : {}) });
  return { deps, ledger, logins, calls, rows, published, hit };
}

describe("SwitchSessionAccount", () => {
  it("moves the session to the next sign-in, records the switch, then continues the turn", async () => {
    const t = setup();
    assert.equal(await t.hit(), "switched");
    assert.deepEqual(t.calls, ["switch:/acc/claude-w", "send:continue"]);
    assert.deepEqual(t.rows, [{
      type: "account_switched",
      payload: { provider: "anthropic", from: "Personal", to: "Work", reason: "limit", resetsAt: new Date(NOW + 2 * 3_600_000).toISOString() },
    }]);
    assert.equal(t.ledger.readiness("p", true), "limited");
  });

  it("moves to the sign-in with the most room left; unknown use counts as none", async () => {
    const t = setup({ used: { w: 70, x: 20 } });
    await t.hit();
    assert.equal(t.calls[0], "switch:/acc/claude-x");
    const unknown = setup({ used: { w: 5 } });
    await unknown.hit();
    assert.equal(unknown.calls[0], "switch:/acc/claude-x");
  });

  it("goes to the default when the sign-in that ran out isn't it", async () => {
    const t = setup();
    await t.hit("/acc/claude-w");
    assert.deepEqual(t.calls[0], "switch:/acc/claude-p");
  });

  it("with no other sign-in ready it records the exhausted row and tells the user", async () => {
    const t = setup({ signedOut: ["w"], apiKey: true });
    t.ledger.mark("x", "limit", NOW + 60_000);
    assert.equal(await t.hit(), "exhausted");
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.rows, [{
      type: "accounts_exhausted",
      payload: { provider: "anthropic", nextResetAt: new Date(NOW + 60_000).toISOString(), apiKey: true },
    }]);
    const banner = t.published.find((p) => p.topic === "notification:fire")?.payload as { title: string; body: string; workerId: string };
    assert.equal(banner.title, "Claude accounts are out");
    assert.match(banner.body, /^Builder stopped — the next limit resets at /);
    assert.equal(banner.workerId, "w1");
  });

  it("every sign-in out for good: no reset to wait for", async () => {
    const t = setup({ signedOut: ["w", "x"] });
    assert.equal(await t.hit("/acc/claude-p", "expired", undefined), "exhausted");
    assert.deepEqual(t.rows[0].payload, { provider: "anthropic", apiKey: false });
  });

  it("a sign-in that stopped working is out until signed in again, and the switch says so", async () => {
    const t = setup();
    assert.equal(await t.hit("/acc/claude-p", "expired", undefined), "switched");
    assert.equal((t.rows[0].payload as { reason: string; resetsAt?: string }).reason, "expired");
    assert.equal((t.rows[0].payload as { resetsAt?: string }).resetsAt, undefined);
    assert.equal(t.ledger.readiness("p", true), "out");
  });

  it("with auto-switch off it only sets the sign-in aside", async () => {
    const t = setup({ reg: { autoSwitch: { anthropic: false } } });
    assert.equal(await t.hit(), "kept");
    assert.deepEqual(t.calls, []);
    assert.equal(t.ledger.readiness("p", true), "limited");
  });

  it("does nothing for a store it doesn't list, a session that can't switch, or a failed switch", async () => {
    assert.equal(await setup().hit("/elsewhere"), "kept");
    const incapable = setup({ capable: false });
    assert.equal(await incapable.hit(), "kept");
    assert.deepEqual(incapable.calls, []);
    const failing = setup({ switchOk: false });
    assert.equal(await failing.hit(), "kept");
    assert.deepEqual(failing.rows, []);
    assert.deepEqual(failing.calls, ["switch:/acc/claude-w"]);
  });
});

describe("ContinueOnApiKey", () => {
  it("moves the session to the API key, says so, and continues", async () => {
    const t = setup({ apiKey: true });
    assert.deepEqual(await continueOnApiKey(t.deps, { workerId: "w1", provider: "anthropic" }), { ok: true });
    assert.deepEqual(t.calls, ["switch:api-key", "send:continue"]);
    assert.deepEqual(t.rows, [{ type: "account_switched", payload: { provider: "anthropic", to: "API key", reason: "api_key" } }]);
  });

  it("refuses without a key", async () => {
    const t = setup();
    const r = await continueOnApiKey(t.deps, { workerId: "w1", provider: "anthropic" });
    assert.equal(r.ok, false);
    assert.deepEqual(t.calls, []);
  });
});

describe("PlanLimitLedger", () => {
  it("a limit lifts at its reset; one without a reset is retried after an hour", () => {
    let now = NOW;
    const ledger = new PlanLimitLedger({ now: () => now });
    ledger.mark("a", "limit", NOW + 1000);
    ledger.mark("b", "limit");
    assert.equal(ledger.readiness("a", true), "limited");
    now = NOW + 1000;
    assert.equal(ledger.readiness("a", true), "ready");
    assert.equal(ledger.blocked("b")?.until, NOW + 3_600_000);
  });

  it("a sign-in that stopped working stays out until cleared; signed out is out", () => {
    const ledger = new PlanLimitLedger({ now: () => NOW });
    ledger.mark("a", "expired");
    assert.equal(ledger.readiness("a", true), "out");
    ledger.clear("a");
    assert.equal(ledger.readiness("a", true), "ready");
    assert.equal(ledger.readiness("a", false), "out");
  });
});

describe("PlanLoginService.runnableLogin", () => {
  it("a ready sign-in first; with every one at its limit, one of those; else none", () => {
    const { logins } = setup();
    const of = (states: Record<string, "ready" | "limited" | "out">) => logins.runnableLogin("anthropic", (l) => states[l.id])?.id ?? null;
    assert.equal(of({ p: "limited", w: "ready", x: "ready" }), "w");
    assert.equal(of({ p: "limited", w: "out", x: "limited" }), "p");
    assert.equal(of({ p: "out", w: "out", x: "out" }), null);
  });
});
