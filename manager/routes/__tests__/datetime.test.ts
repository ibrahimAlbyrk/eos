import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../Router.ts";
import { registerDatetimeRoutes } from "../datetime.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import { CurrentDateTimeResponseSchema } from "../../../contracts/src/http.ts";

function containerWith(nowMs: number, zone: string, offsetMin: number) {
  return {
    clock: { now: () => nowMs },
    timeZone: { name: () => zone, offsetMinutesAt: () => offsetMin },
  } as unknown as Container;
}

async function get(c: Container, path: string) {
  const router = new Router();
  registerDatetimeRoutes(router, c);
  const m = router.match("GET", path);
  assert.ok(m, `no GET route matched ${path}`);
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, req: {} as RouteContext["req"], res } as RouteContext);
  return { status, payload };
}

describe("GET /datetime", () => {
  it("returns a CurrentDateTimeResponse-valid body from the injected clock + zone", async () => {
    const epochMs = Date.parse("2026-06-24T11:32:05.123Z");
    const c = containerWith(epochMs, "Europe/Istanbul", 180);
    const out = await get(c, "/datetime");
    assert.equal(out.status, 200);
    const parsed = CurrentDateTimeResponseSchema.parse(out.payload);
    assert.equal(parsed.epochMs, epochMs);
    assert.equal(parsed.timeZone, "Europe/Istanbul");
    assert.equal(parsed.utcOffsetMinutes, 180);
    assert.equal(parsed.iso, "2026-06-24T14:32:05.123+03:00");
    assert.equal(parsed.utc, "2026-06-24T11:32:05.123Z");
  });
});
