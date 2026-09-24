import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerPromptEventRoutes } from "../prompt-events.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

type EventRow = { id: number; ts: number; type: string; payload: string | null };

function containerWith(rows: EventRow[]): Container {
  return {
    events: {
      listByType: (_workerId: string, type: string) => rows.filter((r) => r.type === type),
    },
  } as unknown as Container;
}

async function get(c: Container, path: string) {
  const router = new Router();
  registerPromptEventRoutes(router, c);
  const url = new URL(path, "http://localhost");
  const m = router.match("GET", url.pathname);
  assert.ok(m, `no GET route matched ${url.pathname}`);
  const req = Readable.from([""]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url, req, res, requestId: "t1", method: "GET", path: url.pathname } as RouteContext);
  return { status, payload: payload as EventRow[] };
}

describe("GET /workers/:id/prompt-events", () => {
  it("returns only prompt + marker rows, merged in (ts, id) order", async () => {
    const c = containerWith([
      { id: 1, ts: 100, type: "user_message", payload: JSON.stringify({ text: "one" }) },
      { id: 2, ts: 110, type: "agent_event", payload: "{}" },
      { id: 3, ts: 120, type: "conversation_cleared", payload: "{}" },
      { id: 4, ts: 130, type: "orchestrator_message", payload: JSON.stringify({ text: "two" }) },
      { id: 5, ts: 130, type: "user_message", payload: JSON.stringify({ text: "three" }) },
      { id: 6, ts: 140, type: "message_recalled", payload: "{}" },
    ]);
    const out = await get(c, "/workers/w1/prompt-events");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload.map((r) => r.id), [1, 3, 4, 5, 6]);
  });
});
