import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";
import type { WorkflowRunSnapshot } from "../../../contracts/src/canonical.ts";
import { WorkflowRunService, type WorkflowRunServiceDeps } from "../WorkflowRunService.ts";

const ROOT = "/Users/u/.claude/projects";
const DIR = `${ROOT}/-p/3cad/subagents/workflows/wf_1`;
const RECORD = `${ROOT}/-p/3cad/workflows/wf_1.json`;
const W = "w-1";

const snap = (state: "running" | "done" = "running"): WorkflowRunSnapshot => ({
  phases: [{ index: 1, title: "Review" }],
  agents: [{ index: 1, label: "bugs", phaseIndex: 1, agentId: "a8e1f3e896e86fcec", state }],
  logs: [],
});

let rowId = 0;
const row = (payload: unknown, ts = 100): WorkerEventRow => ({ id: ++rowId, worker_id: W, ts, type: "agent_event", payload: JSON.stringify(payload) });
const STARTED = { type: "workflow_started", callId: "c1", taskId: "t1", runId: "wf_1", name: "review", description: "Review things", transcriptDir: DIR } as const;

function setup(over: Partial<WorkflowRunServiceDeps> = {}) {
  const published: { topic: string; payload: any }[] = [];
  let now = 1000;
  const files = new Map<string, string>();
  const rows: WorkerEventRow[] = [];
  const stops: string[] = [];
  const session = { isAlive: () => true, stopTask: async (id: string) => { stops.push(id); return { ok: true }; } };
  const svc = new WorkflowRunService({
    bus: { publish: (topic, payload) => { published.push({ topic, payload }); } },
    agentEvents: () => rows,
    session: () => session,
    claudeProjectsDir: ROOT,
    readFile: (p) => files.get(p) ?? null,
    now: () => now,
    throttleMs: 500,
    ...over,
  });
  return { svc, published, files, rows, stops, tick: (ms: number) => { now += ms; } };
}

describe("WorkflowRunService — live progress", () => {
  it("relays the first snapshot at once, then at most one per throttle window (the latest)", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { svc, published, tick } = setup();
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap(), updatedAt: 1 });
    assert.equal(published.length, 1);
    assert.equal(published[0].topic, "workflow:progress");
    tick(100);
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap(), updatedAt: 2 });
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap("done"), updatedAt: 3 });
    assert.equal(published.length, 1, "held until the window passes");
    tick(400);
    t.mock.timers.tick(400);
    assert.equal(published.length, 2);
    assert.equal(published[1].payload.updatedAt, 3);
    assert.equal(published[1].payload.snapshot.agents[0].state, "done");
  });

  it("a run's end drops it, cancels a held relay and goes out at once with its status", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { svc, published } = setup();
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap(), usage: { totalTokens: 7 }, updatedAt: 1 });
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap(), updatedAt: 2 });
    svc.observe(W, { type: "workflow_completed", callId: "c1", taskId: "t1", status: "failed", snapshot: snap("done") });
    t.mock.timers.tick(1000);
    assert.deepEqual(published.map((p) => p.payload.status), ["running", "failed"]);
    assert.equal(published[1].payload.snapshot.agents[0].state, "done");
    assert.deepEqual(published[1].payload.usage, { totalTokens: 7 });
    assert.deepEqual(svc.list(W), []);
  });

  it("lists running runs with their launch facts and phase details from the record", () => {
    const { svc, files } = setup();
    files.set(RECORD, JSON.stringify({ phases: [{ title: "Review", detail: "one reviewer per lens" }], logs: ["Review: 3 findings"] }));
    svc.observe(W, STARTED);
    svc.onProgress({ workerId: W, callId: "c1", taskId: "t1", status: "running", snapshot: snap(), usage: { totalTokens: 5 }, updatedAt: 1 });
    const [run] = svc.list(W);
    assert.equal(run.status, "running");
    assert.equal(run.name, "review");
    assert.equal(run.canStop, true);
    assert.deepEqual(run.usage, { totalTokens: 5 });
    assert.equal(run.snapshot.phases[0].detail, "one reviewer per lens");
    assert.deepEqual(run.snapshot.logs, ["Review: 3 findings"]);
    assert.deepEqual(svc.list("w-other"), []);
  });
});

describe("WorkflowRunService — finished runs", () => {
  it("rebuilds a finished run from its two events", () => {
    const { svc, rows } = setup();
    rows.push(row(STARTED, 100), row({ type: "message", role: "assistant", blocks: [] }), row({ type: "workflow_completed", callId: "c1", taskId: "t1", status: "failed", summary: "boom", snapshot: snap("done") }, 900));
    const run = svc.get(W, "c1")!;
    assert.equal(run.status, "failed");
    assert.equal(run.startedAt, 100);
    assert.equal(run.endedAt, 900);
    assert.equal(run.summary, "boom");
    assert.equal(run.snapshot.agents[0].state, "done");
    assert.equal(run.canStop, false);
  });

  it("a run that started, never ended and isn't live was stopped with its session", () => {
    const { svc, rows } = setup();
    rows.push(row(STARTED));
    assert.equal(svc.get(W, "c1")!.status, "stopped");
    assert.equal(svc.get(W, "nope"), null);
  });

  it("an ended run never reports agents still running, even from an older record", () => {
    const { svc, rows } = setup();
    rows.push(row(STARTED), row({ type: "workflow_completed", callId: "c1", taskId: "t1", status: "stopped", snapshot: snap() }, 900));
    assert.deepEqual(svc.get(W, "c1")!.snapshot.agents.map((a) => a.state), ["cancelled"]);
  });
});

describe("WorkflowRunService — agent transcripts", () => {
  const jsonl = [
    { type: "user", uuid: "u1", parentUuid: null, isSidechain: true, message: { role: "user", content: "Review the diff" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: true, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
  ].map((o) => JSON.stringify(o)).join("\n");

  it("reads an agent's rows from the run's own directory", () => {
    const { svc, files } = setup();
    files.set(`${DIR}/agent-a8e1f3e896e86fcec.jsonl`, jsonl);
    svc.observe(W, STARTED);
    const rows = svc.agentRows(W, "c1", "a8e1f3e896e86fcec")!;
    assert.deepEqual(rows.map((r) => r.type), ["user_message", "agent_event"]);
    assert.ok(JSON.stringify(rows[1].payload).includes('"Read"'));
  });

  it("refuses ids that aren't agent ids and dirs outside Claude's projects", () => {
    const { svc, files, rows } = setup();
    files.set(`${DIR}/agent-a8e1f3e896e86fcec.jsonl`, jsonl);
    svc.observe(W, STARTED);
    assert.equal(svc.agentRows(W, "c1", "../../x"), null);
    const outside = "/tmp/subagents/workflows/wf_9";
    files.set(`${outside}/agent-a8e1f3e896e86fcec.jsonl`, jsonl);
    rows.push(row({ ...STARTED, callId: "c9", transcriptDir: outside }));
    assert.equal(svc.agentRows(W, "c9", "a8e1f3e896e86fcec"), null);
  });
});

describe("WorkflowRunService — stop", () => {
  it("stops a live run by its task id", async () => {
    const { svc, stops } = setup();
    svc.observe(W, STARTED);
    assert.deepEqual(await svc.stop(W, "c1"), { ok: true });
    assert.deepEqual(stops, ["t1"]);
  });

  it("404 for an unknown run, 409 when the session can't stop tasks", async () => {
    const { svc } = setup({ session: () => ({ isAlive: () => true }) });
    assert.equal((await svc.stop(W, "c1") as { status: number }).status, 404);
    svc.observe(W, STARTED);
    assert.equal((await svc.stop(W, "c1") as { status: number }).status, 409);
    assert.equal(svc.list(W)[0].canStop, false);
  });
});
