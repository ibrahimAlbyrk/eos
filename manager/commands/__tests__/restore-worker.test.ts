import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { restoreWorkerHandler } from "../handlers/restore-worker.ts";
import type { Container } from "../../container.ts";
import { ConflictError } from "../../../core/src/errors/index.ts";
import { handleError } from "../../middleware/errorHandler.ts";

function harness(rows: Array<{ id: string; parent_id: string | null; archived_at: number | null }>) {
  const setArchived: Array<{ id: string; ts: number | null }> = [];
  const published: Array<{ topic: string; payload: unknown }> = [];
  const c = {
    workers: {
      findById: (id: string) => rows.find((r) => r.id === id) ?? null,
      findChildrenIds: (pid: string) => rows.filter((r) => r.parent_id === pid).map((r) => r.id),
      setArchived: (id: string, ts: number | null) => {
        setArchived.push({ id, ts });
        const r = rows.find((x) => x.id === id);
        if (r) r.archived_at = ts;
      },
    },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
  } as unknown as Container;
  const run = (id: string) => restoreWorkerHandler.run({ id }, undefined as never, { c } as never);
  return { run, setArchived, published };
}

describe("restoreWorkerHandler", () => {
  it("happy path: clears the whole subtree, returns {id, restored[]}", async () => {
    const h = harness([
      { id: "w1", parent_id: null, archived_at: 5000 },
      { id: "w2", parent_id: "w1", archived_at: 5000 },
    ]);
    const res = await h.run("w1");
    assert.deepEqual(res, { status: 200, body: { id: "w1", restored: ["w2", "w1"] } });
    assert.deepEqual(h.setArchived, [{ id: "w2", ts: null }, { id: "w1", ts: null }]);
    assert.deepEqual(
      h.published.filter((p) => p.topic === "worker:change").map((p) => p.payload),
      [{ workerId: "w2", reason: "restored" }, { workerId: "w1", reason: "restored" }],
    );
  });

  it("non-archived target → ConflictError, mapped to 409 by handleError", async () => {
    const h = harness([{ id: "w1", parent_id: null, archived_at: null }]);
    let err: unknown;
    await h.run("w1").catch((e) => { err = e; });
    assert.ok(err instanceof ConflictError);
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: () => {} };
    handleError(res as never, err, { requestId: "r1", method: "POST", path: "/workers/w1/restore", log: { warn: () => {}, error: () => {} } as never });
    assert.equal(status, 409);
  });

  it("archived ancestor → ConflictError, nothing cleared", async () => {
    const h = harness([
      { id: "w1", parent_id: null, archived_at: 5000 },
      { id: "w2", parent_id: "w1", archived_at: 5000 },
    ]);
    await assert.rejects(h.run("w2"), ConflictError);
    assert.equal(h.setArchived.length, 0);
  });
});
