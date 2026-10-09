// POST …/message with a visual answer's `action` (worker and orchestrator routes):
// the session receives "[view action] <label>" + the JSON payload, the chat row
// stores the label and the action for the reply chip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import { registerOrchestratorRoutes } from "../orchestrators.ts";
import type { Container } from "../../container.ts";
import { fakeQueue } from "../../../core/src/__tests__/helpers/fakeMessageQueue.ts";

const ACTION = { viewId: "v_AbCdEfGh1234", actionId: "fix", label: "Fix all 3 with a worker", viewTitle: "manager · test run", item: "t-sock" };
const MODEL_TEXT = '[view action] Fix all 3 with a worker\n{"viewId":"v_AbCdEfGh1234","actionId":"fix","item":"t-sock"}';

function containerFor(isOrchestrator: boolean) {
  const sent: string[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const row = { id: "a1", name: "a1", state: "IDLE", backend_kind: "inproc", is_orchestrator: isOrchestrator ? 1 : 0, archived_at: null, session_id: null, port: null };
  const session = {
    capabilities: { reportsMessageEvents: false },
    isAlive: () => true,
    sendMessage: async (text: string) => { sent.push(text); return { ok: true, status: 200, body: { ok: true } }; },
  };
  const backend = { kind: "inproc", descriptor: { processModel: "in-process", capabilities: {} }, attach: () => session };
  const c = {
    workers: { findById: (id: string) => (id === "a1" ? row : null), updateState: () => {}, setTurnStartedAt: () => {} },
    events: {
      append: (_id: string, _ts: number, type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); return events.length; },
      listByType: () => [],
    },
    bus: { publish: () => {} },
    clock: { now: () => 1 },
    messageQueue: fakeQueue().repo,
    backends: { has: (k: string) => k === "inproc", get: () => backend },
    compaction: { isCompacting: () => false },
    supervisor: { has: () => false },
    turnSettle: { clear: () => {} },
    loops: { findActiveByWorker: () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as Container;
  return { c, sent, events };
}

async function post(c: Container, path: string, body: unknown) {
  const router = new Router();
  registerWorkerRoutes(router, c);
  registerOrchestratorRoutes(router, c);
  const url = new URL(path, "http://localhost");
  const m = router.match("POST", url.pathname);
  assert.ok(m, `no route for ${path}`);
  const req = Readable.from([JSON.stringify(body)]) as unknown as RouteContext["req"];
  let status = 0;
  const res = { writeHead: (s: number) => { status = s; }, end: () => {} } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url, req, res, requestId: "t", method: "POST", path: url.pathname } as RouteContext);
  return status;
}

describe("POST …/message — view actions", () => {
  for (const [label, path, isOrch] of [["worker", "/workers/a1/message", false], ["orchestrator", "/orchestrators/a1/message", true]] as const) {
    it(`${label} route: model text vs the chat's label + action`, async () => {
      const { c, sent, events } = containerFor(isOrch);
      const status = await post(c, path, { text: ACTION.label, action: ACTION });
      assert.equal(status, 200);
      assert.deepEqual(sent, [MODEL_TEXT]);
      assert.deepEqual(events.filter((e) => e.type === "user_message").map((e) => e.payload), [
        { text: "Fix all 3 with a worker", action: { viewId: ACTION.viewId, label: ACTION.label, viewTitle: ACTION.viewTitle } },
      ]);
    });
  }

  it("rejects a malformed action (bad view id) before dispatch", async () => {
    const { c, sent } = containerFor(false);
    await assert.rejects(post(c, "/workers/a1/message", { text: "x", action: { ...ACTION, viewId: "nope" } }));
    assert.deepEqual(sent, []);
  });
});
