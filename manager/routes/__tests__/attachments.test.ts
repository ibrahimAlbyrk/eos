import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerAttachmentRoutes } from "../attachments.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { WorkerAttachmentsResponse } from "../../../contracts/src/http.ts";

// Each row is a user_message event; text carries the attachment suffix the
// shared parser (contracts/src/attachments.ts) splits off. listByType returns
// rows id-ASC, so the route unions by path with the earliest sighting winning.
type EventRow = { id: number; ts: number; type: string; payload: string | null };

function userMsg(id: number, ts: number, body: string, paths: Array<[string, string]>): EventRow {
  const suffix = paths.length
    ? "\n\nattachments:\n" + paths.map(([label, path]) => `- [${label}] (file): ${path}`).join("\n")
    : "";
  return { id, ts, type: "user_message", payload: JSON.stringify({ text: body + suffix }) };
}

function containerWith(rows: EventRow[]): Container {
  return {
    events: {
      listByType: (_workerId: string, type: string) => rows.filter((r) => r.type === type),
    },
  } as unknown as Container;
}

async function get(c: Container, path: string) {
  const router = new Router();
  registerAttachmentRoutes(router, c);
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
  return { status, payload: payload as WorkerAttachmentsResponse };
}

describe("GET /workers/:id/attachments", () => {
  it("unions attachments across every user_message and dedupes by path (earliest wins)", async () => {
    const c = containerWith([
      userMsg(1, 100, "first", [["a.txt", "/abs/a.txt"], ["b.txt", "/abs/b.txt"]]),
      userMsg(2, 200, "second", [["a-again.txt", "/abs/a.txt"], ["c.txt", "/abs/c.txt"]]),
    ]);
    const out = await get(c, "/workers/w1/attachments");
    assert.equal(out.status, 200);
    const byPath = out.payload.attachments;
    assert.deepEqual(byPath.map((a) => a.path), ["/abs/a.txt", "/abs/b.txt", "/abs/c.txt"]);
    // /abs/a.txt appears in both messages — the earliest (messageId 1, ts 100)
    // survives; the later duplicate is dropped, not overwritten.
    const a = byPath.find((x) => x.path === "/abs/a.txt");
    assert.deepEqual({ label: a?.label, messageId: a?.messageId, ts: a?.ts }, { label: "[a.txt]", messageId: 1, ts: 100 });
  });

  it("returns an empty list when no user_message carries attachments", async () => {
    const c = containerWith([userMsg(1, 100, "plain text", [])]);
    const out = await get(c, "/workers/w1/attachments");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { attachments: [] });
  });
});
