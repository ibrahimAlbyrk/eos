import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReportGapService, type ReportGapDeps } from "../ReportGapService.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

// A minimal bus that captures subscribers by topic so a test can emit
// worker:report / worker:exit directly at the service's handlers.
function makeBus() {
  const subs = new Map<string, Array<(msg: { topic: string; payload: unknown; ts: number }) => void>>();
  return {
    bus: {
      subscribe(topic: string, fn: (msg: { topic: string; payload: unknown; ts: number }) => void) {
        const arr = subs.get(topic) ?? [];
        arr.push(fn);
        subs.set(topic, arr);
        return () => {};
      },
      publish() {},
    },
    emit(topic: string, payload: unknown) {
      for (const fn of subs.get(topic) ?? []) fn({ topic, payload, ts: 0 });
    },
  };
}

function makeService(opts: {
  state?: string; live?: boolean; agentRole?: string | null; parentId?: string | null; activeLoop?: unknown;
} = {}) {
  const dispatched: Array<{ workerId: string; text: string; envelope: unknown; queueWhenBusy: boolean; origin: string }> = [];
  const worker = {
    id: "w-1",
    state: opts.state ?? "IDLE",
    agent_role: opts.agentRole === undefined ? "worker" : opts.agentRole,
    parent_id: opts.parentId === undefined ? "p-1" : opts.parentId,
  };
  const { bus, emit } = makeBus();
  const deps = {
    workers: { findById: (id: string) => (id === "w-1" ? worker : null) },
    loops: { findActiveByWorker: () => opts.activeLoop ?? null },
    isLive: () => opts.live ?? true,
    dispatch: async (input: typeof dispatched[number]) => { dispatched.push(input); return {}; },
    renderer: { render: () => "REMIND" },
    bus,
    log: noopLog,
  } as unknown as ReportGapDeps;
  const svc = new ReportGapService(deps);
  svc.start();
  return { svc, dispatched, emit };
}

describe("ReportGapService", () => {
  it("fires exactly one report_reminder when all guards pass", async () => {
    const { svc, dispatched } = makeService();
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].origin, "report-reminder");
    assert.equal(dispatched[0].queueWhenBusy, true);
    assert.deepEqual(dispatched[0].envelope, { kind: "report_reminder" });
    assert.equal(dispatched[0].text, "REMIND");
  });

  it("marks reported on worker:report → no reminder", async () => {
    const { svc, dispatched, emit } = makeService();
    emit("worker:report", { workerId: "w-1", parentId: "p-1", text: "result: done", held: false });
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("a HELD report also marks reported → no reminder", async () => {
    const { svc, dispatched, emit } = makeService();
    emit("worker:report", { workerId: "w-1", parentId: "p-1", text: "result: done", held: true });
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0);
  });

  it("second checkOnIdle after a reminder → no-op (once-per-life guard)", async () => {
    const { svc, dispatched } = makeService();
    svc.checkOnIdle("w-1");
    await flush();
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);
  });

  it("no-ops for each exclusion (state/live/role/parent/loop)", async () => {
    const cases: Array<Parameters<typeof makeService>[0]> = [
      { state: "WORKING" },
      { live: false },
      { agentRole: "orchestrator" },
      { agentRole: "git" },
      { agentRole: "workflow-worker" },
      { agentRole: null },
      { parentId: null },
      { activeLoop: { id: "l-1" } },
    ];
    for (const opts of cases) {
      const { svc, dispatched } = makeService(opts);
      svc.checkOnIdle("w-1");
      await flush();
      assert.equal(dispatched.length, 0, `expected no reminder for ${JSON.stringify(opts)}`);
    }
  });

  it("worker:exit reclaims `reported` — a resumed worker owes a fresh report", async () => {
    const { svc, dispatched, emit } = makeService();
    emit("worker:report", { workerId: "w-1", held: false });
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 0); // disarmed by the report

    emit("worker:exit", { workerId: "w-1" });
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1); // reported was reclaimed → fires
  });

  it("worker:exit reclaims `reminded` — the once-guard resets across lives", async () => {
    const { svc, dispatched, emit } = makeService();
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 1);

    emit("worker:exit", { workerId: "w-1" });
    svc.checkOnIdle("w-1");
    await flush();
    assert.equal(dispatched.length, 2); // reminded was reclaimed → fires again
  });
});
