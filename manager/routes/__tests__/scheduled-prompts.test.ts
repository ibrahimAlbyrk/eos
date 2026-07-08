import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { Router } from "../Router.ts";
import { registerScheduledPromptRoutes } from "../scheduled-prompts.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { SqliteScheduledPromptRepo } from "../../../infra/src/persistence/SqliteScheduledPromptRepo.ts";
import { runMigrations } from "../../../infra/src/persistence/MigrationRunner.ts";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import { SchedulerService } from "../../services/SchedulerService.ts";
import { emitScheduledPromptEvent } from "../../shared/scheduled-prompt-events.ts";
import type { EventBusMessage } from "../../../core/src/ports/EventBus.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

// Real bus + real repo; a wildcard subscriber mirrors SseBroadcaster's "*"
// subscription so we assert exactly what would become an SSE reason.
function harness() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  const scheduledPrompts = new SqliteScheduledPromptRepo(db);
  const bus = createInMemoryEventBus();
  const relayed: EventBusMessage[] = [];
  bus.subscribe("*", (msg) => relayed.push(msg));
  let n = 0;
  const c = {
    scheduledPrompts,
    bus,
    events: { append: () => ++n },
    clock: { now: () => 1000 },
    ids: { newScheduledPromptId: () => "sp-test" },
  } as unknown as Container;
  return { c, bus, scheduledPrompts, relayed };
}

async function call(c: Container, method: string, path: string, body?: unknown) {
  const router = new Router();
  registerScheduledPromptRoutes(router, c);
  const m = router.match(method, path);
  assert.ok(m, `no ${method} route matched ${path}`);
  const req = (body !== undefined
    ? Readable.from([JSON.stringify(body)])
    : { headers: {} }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: new URL(`http://x${path}`), req, res } as RouteContext);
  return { status, payload };
}

const reasons = (relayed: EventBusMessage[]) => relayed.map((m) => m.topic);

describe("scheduled-prompts routes — SSE seam", () => {
  it("POST publishes scheduled_prompt:created on the bus (relayed as an SSE reason)", async () => {
    const { c, relayed } = harness();
    const out = await call(c, "POST", "/scheduled-prompts", { workerId: "orch-1", text: "hi", fireAt: 5000 });
    assert.equal(out.status, 201);
    const created = relayed.find((m) => m.topic === "scheduled_prompt:created");
    assert.ok(created, `expected scheduled_prompt:created, saw ${reasons(relayed).join(",")}`);
    assert.deepEqual(created!.payload, { workerId: "orch-1", id: "sp-test" });
  });

  it("DELETE of a pending row publishes scheduled_prompt:cancelled", async () => {
    const { c, scheduledPrompts, relayed } = harness();
    scheduledPrompts.insert({ id: "sp-1", workerId: "orch-1", text: "x", fireAt: 5000, createdAt: 0 });
    const out = await call(c, "DELETE", "/scheduled-prompts/sp-1");
    assert.equal(out.status, 200);
    const cancelled = relayed.find((m) => m.topic === "scheduled_prompt:cancelled");
    assert.ok(cancelled, `expected scheduled_prompt:cancelled, saw ${reasons(relayed).join(",")}`);
    assert.deepEqual(cancelled!.payload, { workerId: "orch-1", id: "sp-1" });
  });

  it("DELETE of a non-pending/unknown row is a 404 and publishes no scheduled_prompt:* reason", async () => {
    const { c, relayed } = harness();
    const out = await call(c, "DELETE", "/scheduled-prompts/missing");
    assert.equal(out.status, 404);
    assert.equal(relayed.filter((m) => String(m.topic).startsWith("scheduled_prompt:")).length, 0);
  });

  // Mirrors the container's onFired wiring exactly (same helper, same shape) so
  // the fire path's SSE reason is covered by production code, not a re-impl.
  it("SchedulerService fire publishes scheduled_prompt:fired via onFired", async () => {
    const { bus, scheduledPrompts, relayed } = harness();
    scheduledPrompts.insert({ id: "sp-9", workerId: "orch-1", text: "go", fireAt: 500, createdAt: 0 });
    const scheduler = new SchedulerService({
      repo: scheduledPrompts,
      clock: { now: () => 1000 },
      dispatch: async () => ({ status: 202, body: {} }),
      onFired: (row) => emitScheduledPromptEvent(
        { events: { append: () => 1 }, bus, clock: { now: () => 1000 } } as never,
        "scheduled_prompt:fired",
        row.workerId,
        row.id,
        { fireAt: row.fireAt },
      ),
      log: noopLog as never,
    });
    await scheduler.tick();
    const fired = relayed.find((m) => m.topic === "scheduled_prompt:fired");
    assert.ok(fired, `expected scheduled_prompt:fired, saw ${reasons(relayed).join(",")}`);
    assert.deepEqual(fired!.payload, { workerId: "orch-1", id: "sp-9" });
    assert.equal(scheduledPrompts.findById("sp-9")!.status, "fired");
  });
});
