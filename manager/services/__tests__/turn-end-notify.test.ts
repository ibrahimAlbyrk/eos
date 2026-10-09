import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { makeTurnEndNotify, type TurnEndNotifyDeps } from "../turn-end-notify.ts";
import type { NotificationFire } from "../permission-ask-notify.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

const orchestrator = {
  id: "w-top", name: "Orchestrator", parent_id: null, state: "IDLE", turn_started_at: 100,
} as unknown as WorkerRow;

let seq = 0;
function row(type: string, payload: unknown, ts: number): WorkerEventRow {
  return { id: ++seq, worker_id: "w-top", ts, type, payload: JSON.stringify(payload) };
}
const reply = (text: string, ts: number) =>
  row("agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text }] }, ts);

const present = (input: Record<string, unknown>, ts: number, lead?: string) =>
  row("agent_event", {
    type: "message", role: "assistant",
    blocks: [...(lead ? [{ type: "text", text: lead }] : []), { type: "tool_call", callId: `c${ts}`, name: "mcp__orchestrator__present", input }],
  }, ts);

const IDLE_EDGE = { workerId: "w-top", from: "WORKING", state: "IDLE" };

function build(over: Partial<TurnEndNotifyDeps> = {}, rows: WorkerEventRow[] = []) {
  const fired: NotificationFire[] = [];
  const notify = makeTurnEndNotify({
    findWorker: (id) => (id === "w-top" ? orchestrator : null),
    eventsSince: (_id, since) => rows.filter((r) => r.ts > since),
    liveSubagents: () => 0,
    fire: (n) => fired.push(n),
    now: () => 42,
    defer: (fn) => fn(),
    ...over,
  });
  const bus = createInMemoryEventBus();
  // The exact daemon subscriber predicate.
  bus.subscribe("worker:change", (msg) => notify(msg.payload as { workerId?: string; from?: string; state?: string }));
  return { bus, fired };
}

describe("turn-end notification (worker:change WORKING→IDLE → notification:fire)", () => {
  it("titles with the agent name and carries this turn's last reply, whitespace collapsed", () => {
    const { bus, fired } = build({}, [
      reply("previous turn", 50),
      row("user_message", { text: "build it" }, 100),
      reply("Starting.", 110),
      reply("All done.\n\nTests   pass.", 120),
    ]);
    bus.publish("worker:change", IDLE_EDGE);
    assert.deepEqual(fired, [{ title: "Orchestrator", body: "All done. Tests pass.", workerId: "w-top", ts: 42 }]);
  });

  it("a turn that answered with a view carries the view's summary, not the lead-in before it", () => {
    const { bus, fired } = build({}, [
      row("user_message", { text: "where to eat?" }, 100),
      reply("Let me look up places nearby.", 105),
      present({ title: "Kadıköy tonight", summary: "6 places open. Best: Moda Kıyı.", ui: "<Map/>" }, 110, "Here you go."),
    ]);
    bus.publish("worker:change", IDLE_EDGE);
    assert.equal(fired[0]?.body, "6 places open. Best: Moda Kıyı.");
  });

  it("text written after the view is the last word; a view without summary falls back to its title", () => {
    const after = build({}, [present({ title: "T", summary: "S" }, 110), reply("Moda Kıyı is the pick.", 120)]);
    after.bus.publish("worker:change", IDLE_EDGE);
    assert.equal(after.fired[0]?.body, "Moda Kıyı is the pick.");
    const titled = build({}, [present({ title: "Kadıköy tonight" }, 110)]);
    titled.bus.publish("worker:change", IDLE_EDGE);
    assert.equal(titled.fired[0]?.body, "Kadıköy tonight");
  });

  it("truncates a long reply", () => {
    const { bus, fired } = build({}, [reply("x".repeat(500), 110)]);
    bus.publish("worker:change", IDLE_EDGE);
    assert.equal(fired[0]?.body.length, 160);
    assert.ok(fired[0]?.body.endsWith("…"));
  });

  it("skips non-edges, sub-workers, a worker back at WORKING, and a turn with no reply", () => {
    const rows = [reply("done", 110)];
    const plain = build({}, rows);
    plain.bus.publish("worker:change", { workerId: "w-top" });
    plain.bus.publish("worker:change", { workerId: "w-top", from: "SPAWNING", state: "IDLE" });
    assert.equal(plain.fired.length, 0);

    const child = build({ findWorker: () => ({ ...orchestrator, parent_id: "w-top" }) }, rows);
    child.bus.publish("worker:change", IDLE_EDGE);
    assert.equal(child.fired.length, 0);

    const busy = build({ findWorker: () => ({ ...orchestrator, state: "WORKING" }) }, rows);
    busy.bus.publish("worker:change", IDLE_EDGE);
    assert.equal(busy.fired.length, 0);

    const silent = build({}, [reply("previous turn", 50)]);
    silent.bus.publish("worker:change", IDLE_EDGE);
    assert.equal(silent.fired.length, 0);
  });

  it("waits for background subagents: no banner while one runs, one once the last is done", () => {
    let live = 2;
    const { bus, fired } = build({ liveSubagents: () => live }, [reply("Launched 2 agents.", 110)]);
    bus.publish("worker:change", IDLE_EDGE);
    live = 1; // first report woke the agent, which went idle again
    bus.publish("worker:change", IDLE_EDGE);
    assert.equal(fired.length, 0);
    live = 0;
    bus.publish("worker:change", IDLE_EDGE);
    assert.equal(fired.length, 1);
  });
});
