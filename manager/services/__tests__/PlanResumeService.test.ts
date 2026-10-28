import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlanResumeService } from "../PlanResumeService.ts";
import { PlanLoginService } from "../../../core/src/services/PlanLoginService.ts";
import { PlanLimitLedger } from "../../../core/src/services/PlanLimitLedger.ts";
import type { AgentBackendRegistry, AgentSession } from "../../../core/src/ports/AgentBackend.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

const NOW = Date.UTC(2026, 9, 28, 14);
const RESET = NOW + 2 * 3_600_000;

function setup(opts: { state?: string; limited?: boolean } = {}) {
  let now = NOW;
  const clock = { now: () => now };
  const rows: WorkerEventRow[] = [];
  const add = (type: string, payload: unknown) => {
    rows.push({ id: rows.length + 1, worker_id: "w1", ts: now, type, payload: JSON.stringify(payload) });
    return rows.length;
  };
  const exhaustedId = add("accounts_exhausted", { provider: "anthropic", nextResetAt: new Date(RESET).toISOString(), apiKey: false });
  const calls: string[] = [];
  const session = {
    capabilities: { accountSwitch: true },
    isAlive: () => true,
    switchAccount: async (c: { storeDir: string }) => { calls.push(`switch:${c.storeDir}`); return { ok: true }; },
    sendMessage: async (text: string) => { calls.push(`send:${text}`); return { ok: true }; },
  } as unknown as AgentSession;
  const logins = new PlanLoginService({
    store: { load: () => ({ logins: [{ id: "p", provider: "anthropic", label: "Personal", storeDir: "/acc/claude-p", createdAt: "t" }], defaults: {} }), save: () => {} },
    dirs: { create: () => "", discard: () => {}, trash: () => {} },
    clock,
    newId: () => "n",
  });
  const ledger = new PlanLimitLedger(clock);
  ledger.mark("p", "limit", opts.limited ? RESET + 3_600_000 : RESET);
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const svc = new PlanResumeService({
    workers: { findById: () => ({ id: "w1", state: opts.state ?? "IDLE", backend_kind: "claude" }) as never },
    events: {
      append: (_w, _ts, type, payload) => add(type, payload),
      findById: (_w, id) => rows.find((r) => r.id === id) ?? null,
      patchPayload: (id, payload) => { rows[id - 1] = { ...rows[id - 1], payload: JSON.stringify(payload) }; },
      list: (q) => rows.filter((r) => r.id > (q.afterId ?? 0)),
    },
    bus: { publish: () => {} },
    clock,
    backends: { has: () => true, get: () => ({ attach: () => session }) } as unknown as AgentBackendRegistry,
    continuation: () => "continue",
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    logins,
    ledger,
    signedIn: () => true,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
  });
  const payload = () => JSON.parse(rows[exhaustedId - 1].payload!) as Record<string, unknown>;
  const fire = async () => { now = RESET + 60_000; timers.at(-1)!.fn(); await new Promise((r) => setImmediate(r)); };
  return { svc, rows, add, calls, timers, payload, fire, exhaustedId };
}

describe("PlanResumeService", () => {
  it("schedules for the reset (plus slack), shows it on the row, then resumes on the sign-in that came back", async () => {
    const t = setup();
    assert.deepEqual(t.svc.schedule("w1", t.exhaustedId), { ok: true });
    assert.equal(t.timers[0].ms, RESET - NOW + 30_000);
    assert.equal(t.payload().resumeAt, new Date(RESET).toISOString());
    await t.fire();
    assert.deepEqual(t.calls, ["switch:/acc/claude-p", "send:continue"]);
    assert.equal(t.payload().resumed, true);
    assert.equal(t.payload().resumeAt, undefined);
    assert.equal(t.rows.at(-1)!.type, "account_switched");
  });

  it("cancel drops the timer and the schedule", () => {
    const t = setup();
    t.svc.schedule("w1", t.exhaustedId);
    t.svc.cancel("w1", t.exhaustedId);
    assert.equal(t.timers[0].cleared, true);
    assert.equal(t.payload().resumeAt, undefined);
  });

  it("stands down when the user sent something since, the agent is busy, or no sign-in is ready yet", async () => {
    const sent = setup();
    sent.svc.schedule("w1", sent.exhaustedId);
    sent.add("user_message", { text: "never mind" });
    await sent.fire();
    assert.deepEqual(sent.calls, []);
    assert.equal(sent.payload().resumed, undefined);

    const busy = setup({ state: "WORKING" });
    busy.svc.schedule("w1", busy.exhaustedId);
    await busy.fire();
    assert.deepEqual(busy.calls, []);

    const early = setup({ limited: true });
    early.svc.schedule("w1", early.exhaustedId);
    await early.fire();
    assert.deepEqual(early.calls, []);
  });

  it("refuses rows it can't resume", () => {
    const t = setup();
    const other = t.add("conversation_cleared", {});
    assert.equal(t.svc.schedule("w1", other).ok, false);
    const noReset = t.add("accounts_exhausted", { provider: "anthropic", apiKey: false });
    assert.equal(t.svc.schedule("w1", noReset).ok, false);
  });
});
