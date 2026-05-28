import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processWorkerEvent, type ProcessWorkerEventDeps } from "../use-cases/ProcessWorkerEvent.ts";
import type { ModelCatalog, ModelPrice } from "../domain/value-objects.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { UsageDelta } from "../ports/WorkerRepo.ts";

// Minimal in-memory fakes — enough to exercise the usage handler.
interface AppendedEvent { workerId: string; ts: number; type: string; payload: unknown }
interface BusEvent { topic: string; payload: unknown }
interface LogCall { level: "info" | "warn" | "error"; msg: string; ctx?: unknown }

function buildDeps(opts: { price: ModelPrice; row?: Partial<WorkerRow> }): {
  deps: ProcessWorkerEventDeps;
  recordedDeltas: UsageDelta[];
  bus: BusEvent[];
  events: AppendedEvent[];
  logs: LogCall[];
  patchedPayloads: Array<{ rowId: number; payload: unknown }>;
} {
  const recordedDeltas: UsageDelta[] = [];
  const bus: BusEvent[] = [];
  const events: AppendedEvent[] = [];
  const logs: LogCall[] = [];
  const patchedPayloads: Array<{ rowId: number; payload: unknown }> = [];

  const workers = {
    findById: (_id: string) => (opts.row ?? { model: "opus" }) as WorkerRow,
    addUsage: (_id: string, d: UsageDelta) => { recordedDeltas.push(d); },
  } as unknown as ProcessWorkerEventDeps["workers"];

  const eventsRepo = {
    append: (workerId: string, ts: number, type: string, payload: unknown) => {
      events.push({ workerId, ts, type, payload });
      return events.length;
    },
    patchPayload: (rowId: number, payload: unknown) => { patchedPayloads.push({ rowId, payload }); },
  } as unknown as ProcessWorkerEventDeps["events"];

  const eventBus = {
    publish: (topic: string, payload: unknown) => { bus.push({ topic, payload }); },
    subscribe: () => () => {},
  } as unknown as ProcessWorkerEventDeps["bus"];

  const logger = {
    info: (msg: string, ctx?: unknown) => { logs.push({ level: "info", msg, ctx }); },
    warn: (msg: string, ctx?: unknown) => { logs.push({ level: "warn", msg, ctx }); },
    error: (msg: string, ctx?: unknown) => { logs.push({ level: "error", msg, ctx }); },
    child: () => logger,
  } as unknown as ProcessWorkerEventDeps["log"];

  const catalog: ModelCatalog = { priceFor: () => opts.price };
  const clock = { now: () => 1234 } as ProcessWorkerEventDeps["clock"];

  const deps: ProcessWorkerEventDeps = {
    workers,
    events: eventsRepo,
    bus: eventBus,
    clock,
    models: catalog,
    log: logger,
  };
  return { deps, recordedDeltas, bus, events, logs, patchedPayloads };
}

describe("ProcessWorkerEvent.usage", () => {
  it("records cost zero and logs error when price yields NaN", () => {
    const { deps, recordedDeltas, logs } = buildDeps({
      price: { in: NaN, out: NaN, cacheRead: NaN, cacheCreate: NaN, cacheCreate1h: NaN },
    });
    processWorkerEvent(deps, {
      workerId: "w1",
      type: "usage",
      payload: { in: 100, out: 50, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, model: "opus" },
    });
    assert.equal(recordedDeltas.length, 1);
    assert.equal(recordedDeltas[0].costUsd, 0);
    const errors = logs.filter((l) => l.level === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0].msg, /deltaCost is invalid/);
  });

  it("warns when usage event has no model and worker row has none either", () => {
    const { deps, logs } = buildDeps({
      price: { in: 15, out: 75, cacheRead: 1.5, cacheCreate: 18.75, cacheCreate1h: 30 },
      row: { model: null } as Partial<WorkerRow>,
    });
    processWorkerEvent(deps, {
      workerId: "w1",
      type: "usage",
      payload: { in: 1000, out: 500 },
    });
    const warns = logs.filter((l) => l.level === "warn");
    assert.equal(warns.length, 1);
    assert.match(warns[0].msg, /missing model/);
  });

  it("computes cost correctly including 1h cache writes", () => {
    const { deps, recordedDeltas, patchedPayloads } = buildDeps({
      price: { in: 3, out: 15, cacheRead: 0.3, cacheCreate: 3.75, cacheCreate1h: 6 },
    });
    processWorkerEvent(deps, {
      workerId: "w1",
      type: "usage",
      payload: { in: 1_000_000, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 1_000_000, model: "sonnet" },
    });
    // 1M input × $3 + 1M cache1h × $6 = $3 + $6 = $9
    assert.equal(recordedDeltas[0].costUsd, 9);
    const last = patchedPayloads.at(-1);
    assert.ok(last);
    const payload = last.payload as { deltaCost: number };
    assert.equal(payload.deltaCost, 9);
  });
});
