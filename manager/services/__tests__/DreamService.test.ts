import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DreamService, type DreamRunOptions } from "../DreamService.ts";
import { DEFAULT_DREAMING, type DreamingSettings } from "../../../contracts/src/profile.ts";
import type { DreamRun } from "../../../contracts/src/dream.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

function harness(opts: { settings?: Partial<DreamingSettings>; signedIn?: boolean; usage?: number | null; proposed?: number } = {}) {
  let now = at(3, 15);
  let settings: DreamingSettings = { ...DEFAULT_DREAMING, enabled: false, ...opts.settings };
  const saved: DreamRun[] = [];
  const events: { runId: string | null; status: string }[] = [];
  const notes: DreamRun[] = [];
  const runs: DreamRunOptions[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const svc = new DreamService({
    run: async (o) => {
      runs.push(o);
      if (hold) await new Promise<void>((r) => { release = r; });
      const run: DreamRun = {
        id: `dr-${runs.length}`, trigger: o.trigger, status: o.shouldStop() ? "stopped" : "done", reason: null,
        startedAt: now, finishedAt: now, model: "opus", chatsRead: 1, observations: 1, proposed: opts.proposed ?? 2,
        tokens: 10, narrative: "You asked for depth.", dropped: { oneOff: 0, known: 0, declined: 0, secret: 0, weak: 0, invalid: 0 }, chats: [],
      };
      saved.push(run);
      return run;
    },
    repo: { latest: () => saved.at(-1) ?? null, save: (r) => { saved.push(r); } },
    settings: () => settings,
    clock: { now: () => now },
    bus: { publish: (_t, p) => { events.push(p as { runId: string | null; status: string }); } },
    signedIn: () => opts.signedIn ?? true,
    usage: async () => (opts.usage === undefined ? 0.2 : opts.usage),
    anyWorking: () => false,
    newId: () => `dr-skip${saved.length}`,
    notify: (r) => { notes.push(r); },
    log: noopLog,
  });
  return {
    svc, saved, events, notes, runs,
    setNow: (t: number) => { now = t; },
    set: (p: Partial<DreamingSettings>) => { settings = { ...settings, ...p }; },
    hold: () => { hold = true; },
    release: () => release?.(),
  };
}

describe("DreamService", () => {
  it("off → never dreams", async () => {
    const h = harness();
    await h.svc.tick();
    h.setNow(at(4, 4));
    await h.svc.tick();
    assert.equal(h.runs.length, 0);
    assert.equal(h.svc.status().blocked, "disabled");
  });

  it("switched on in the afternoon, it waits for tonight's slot, then dreams once", async () => {
    const h = harness();
    await h.svc.tick();
    h.set({ enabled: true });
    await h.svc.tick(); // 15:00 — just enabled
    assert.equal(h.runs.length, 0);
    assert.equal(h.svc.status().nextAt, at(4, 3));
    h.setNow(at(4, 3, 1));
    await h.svc.tick();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0]!.trigger, "nightly");
    h.setNow(at(4, 9));
    await h.svc.tick();
    assert.equal(h.runs.length, 1);
    assert.equal(h.notes.length, 1); // morning note: it filed proposals
  });

  it("no sign-in or usage above the line → a skipped night, no model call", async () => {
    for (const [o, re] of [[{ signedIn: false }, /sign-in/], [{ usage: 0.82 }, /82%/]] as const) {
      const h = harness({ ...o, settings: { enabled: true } });
      await h.svc.tick(); // first sight of Dreaming on, no runs yet: wait for tonight
      h.setNow(at(4, 3, 5));
      await h.svc.tick();
      assert.equal(h.runs.length, 0);
      assert.equal(h.saved[0]?.status, "skipped");
      assert.match(h.saved[0]!.reason ?? "", re);
      await h.svc.tick(); // already logged for this slot
      assert.equal(h.saved.length, 1);
    }
  });

  it("the user coming back stops a scheduled dream; Dream now isn't stopped by it", async () => {
    const h = harness({ settings: { enabled: true } });
    await h.svc.tick();
    h.hold();
    h.setNow(at(4, 3, 5));
    const pending = h.svc.tick();
    await new Promise((r) => setImmediate(r));
    assert.ok(h.svc.status().running);
    assert.deepEqual(h.svc.dreamNow(), { started: false, reason: "A dream is already running" });
    h.svc.noteUserActivity();
    h.release();
    await pending;
    assert.equal(h.saved.at(-1)?.status, "stopped");

    const m = harness({ settings: { enabled: true, schedule: "manual" } });
    m.hold();
    assert.deepEqual(m.svc.dreamNow(), { started: true });
    await new Promise((r) => setImmediate(r));
    m.svc.noteUserActivity();
    m.release();
    await new Promise((r) => setImmediate(r));
    assert.equal(m.saved.at(-1)?.status, "done");
    assert.equal(m.saved.at(-1)?.trigger, "manual");
  });

  it("publishes dream:change while running and when done", async () => {
    const h = harness({ settings: { enabled: true, schedule: "manual" }, proposed: 0 });
    h.svc.dreamNow();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.events.map((e) => e.status), ["running", "done"]);
    assert.equal(h.notes.length, 0); // nothing filed → no note
  });
});
