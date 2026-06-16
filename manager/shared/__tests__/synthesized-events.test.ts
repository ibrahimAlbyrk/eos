import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSynthesized, type SynthesizedEventDeps } from "../synthesized-events.ts";

function fakeDeps() {
  const appended: Array<{ workerId: string; ts: number; type: string; payload: unknown }> = [];
  const published: Array<{ topic: string; payload: unknown }> = [];
  let nextRow = 100;
  const deps = {
    events: {
      append(workerId: string, ts: number, type: string, payload: unknown): number {
        appended.push({ workerId, ts, type, payload });
        return ++nextRow;
      },
    },
    bus: {
      publish(topic: string, payload: unknown): void { published.push({ topic, payload }); },
    },
    clock: { now: (): number => 42 },
  } as unknown as SynthesizedEventDeps;
  return { deps, appended, published };
}

test("appendSynthesized appends the row and publishes worker:change with the rowId", () => {
  const { deps, appended, published } = fakeDeps();
  const rowId = appendSynthesized(deps, "w-1", "git_push", { ok: true });
  assert.deepEqual(appended, [{ workerId: "w-1", ts: 42, type: "git_push", payload: { ok: true } }]);
  assert.equal(published.length, 1);
  assert.equal(published[0].topic, "worker:change");
  assert.deepEqual(published[0].payload, { workerId: "w-1", rowId });
});

test("notifyWorkerId refreshes a different worker than the one recorded", () => {
  const { deps, appended, published } = fakeDeps();
  const rowId = appendSynthesized(deps, "asker", "peer_consult", { q: "?" }, "target");
  assert.equal(appended[0].workerId, "asker"); // recorded on the asker's timeline
  assert.deepEqual(published[0].payload, { workerId: "target", rowId }); // refreshes the target's pane
});
