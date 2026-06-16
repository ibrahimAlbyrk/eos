import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { z } from "zod";
import { toRouteHandler, type CommandHandler } from "../pipeline.ts";
import type { CommandDef } from "../../../contracts/src/commands/types.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../../routes/Router.ts";

type EchoAddr = { id: string; tag?: string };
type EchoData = { msg: string };

// A stand-in command exercising the pipeline mechanics without a real handler:
// addr from path params + query, data from the JSON body.
const echoDef: CommandDef<EchoAddr, EchoData, unknown> = {
  name: "test.echo",
  method: "POST",
  pattern: /^\/echo\/(?<id>[^/]+)$/,
  buildPath: ({ id }) => `/echo/${id}`,
  addr: z.object({ id: z.string(), tag: z.string().optional() }),
  data: z.object({ msg: z.string() }),
  output: z.unknown(),
  meta: { summary: "echo", mutates: false, scope: "global" },
};

const echoHandler: CommandHandler<EchoAddr, EchoData, unknown> = {
  def: echoDef,
  async run(addr, data) {
    return { status: 200, body: { addr, data } };
  },
};

function fakeCtx(opts: { params: Record<string, string>; query: string; body: unknown }): {
  rc: RouteContext;
  captured: { status?: number; body?: string };
} {
  const captured: { status?: number; body?: string } = {};
  const req = Readable.from([JSON.stringify(opts.body)]) as unknown as RouteContext["req"];
  const res = {
    writeHead(status: number) { captured.status = status; },
    end(buf: string | Buffer) { captured.body = typeof buf === "string" ? buf : buf.toString("utf8"); },
  } as unknown as RouteContext["res"];
  const rc: RouteContext = {
    method: "POST",
    path: "/echo/x",
    url: new URL(`http://x/echo/x?${opts.query}`),
    params: opts.params,
    req,
    res,
    requestId: "test",
  };
  return { rc, captured };
}

test("pipeline parses addr (params+query) + data (body), runs handler, writes JSON", async () => {
  const { rc, captured } = fakeCtx({ params: { id: "x" }, query: "tag=t", body: { msg: "hi" } });
  await toRouteHandler(echoHandler, {} as Container)(rc);
  assert.equal(captured.status, 200);
  assert.deepEqual(JSON.parse(captured.body ?? "{}"), { addr: { id: "x", tag: "t" }, data: { msg: "hi" } });
});

test("pipeline lets path params win over query on a name clash", async () => {
  const { rc, captured } = fakeCtx({ params: { id: "fromPath" }, query: "id=fromQuery", body: { msg: "hi" } });
  await toRouteHandler(echoHandler, {} as Container)(rc);
  assert.equal(JSON.parse(captured.body ?? "{}").addr.id, "fromPath");
});

test("pipeline throws ValidationError on a bad body (→ central 400)", async () => {
  const { rc } = fakeCtx({ params: { id: "x" }, query: "", body: { msg: 123 } });
  await assert.rejects(() => toRouteHandler(echoHandler, {} as Container)(rc), /invalid request/);
});
