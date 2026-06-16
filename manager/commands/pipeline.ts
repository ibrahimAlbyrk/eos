// The server side of the command catalog: turn a CommandDef + handler into a
// Router route. One pipeline for every command — parse addr (path params +
// query) and data (JSON body), validate both against the def's schemas, run the
// handler, write the JSON result. Domain errors thrown by the handler propagate
// to the daemon's central handleError (ValidationError→400, NotFoundError→404,
// …), so handlers never touch the response object.

import type { RouteContext, RouteHandler } from "../routes/Router.ts";
import type { Container } from "../container.ts";
import type { CommandDef } from "../../contracts/src/commands/types.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { validate } from "../middleware/validate.ts";

export interface CommandCtx {
  readonly c: Container;
  readonly requestId: string;
}

export interface CommandResult<Out> {
  readonly status: number;
  readonly body: Out;
}

export interface CommandHandler<Addr, Data, Out> {
  readonly def: CommandDef<Addr, Data, Out>;
  run(addr: Addr, data: Data, ctx: CommandCtx): Promise<CommandResult<Out>>;
}

export function toRouteHandler<Addr, Data, Out>(
  handler: CommandHandler<Addr, Data, Out>,
  c: Container,
): RouteHandler {
  const { def } = handler;
  return async (rc: RouteContext): Promise<void> => {
    // Addr = path params (from the route regex) overlaid on query params. Params
    // win on a name clash — the URL path is the authoritative locator.
    const query = Object.fromEntries(rc.url.searchParams.entries());
    const addr = validate(def.addr, { ...query, ...rc.params });
    const data =
      def.method === "GET" || def.method === "DELETE"
        ? validate(def.data, {})
        : validate(def.data, await readBody(rc.req));
    const result = await handler.run(addr, data, { c, requestId: rc.requestId });
    writeJson(rc.res, result.status, result.body);
  };
}
