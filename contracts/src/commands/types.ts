// Unified command catalog — every daemon operation is described ONCE here as a
// CommandDef: name + HTTP binding + addr/data/output schemas + meta. The daemon
// registers one route per command (manager/commands/register.ts) and runs them
// through a single validate→handle→respond pipeline; CLI, MCP and web build
// their requests from the same def via commandRequest(), so a path or body
// shape is never hand-spelled (and never drifts) across clients.
//
// Addr vs Data: Addr is everything that lives in the URL (path params + query);
// Data is the JSON body. The split gives every field exactly one home — clients
// build the URL from Addr and send Data as the body, the server parses
// params/query into Addr and the body into Data.

import { z } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type CommandScope = "worker" | "orchestrator" | "global";

export interface CommandMeta {
  readonly summary: string;
  // Mutates server state (vs a pure read). Reserved for cross-cutting
  // middleware (audit, read-only guards); declared now so every command carries
  // the fact, not behavioral yet.
  readonly mutates: boolean;
  readonly scope: CommandScope;
}

export interface CommandDef<Addr, Data, Out> {
  readonly name: string;
  readonly method: HttpMethod;
  // Server route pattern for the first-match Router: a literal path, or a
  // RegExp whose named groups become params.
  readonly pattern: string | RegExp;
  // Client URL builder from Addr (path + any query string).
  readonly buildPath: (addr: Addr) => string;
  readonly addr: z.ZodType<Addr>;
  readonly data: z.ZodType<Data>;
  readonly output: z.ZodType<Out>;
  readonly meta: CommandMeta;
}

// Degenerate-case shorthands: a command with no URL params, or no body. Schema
// value carries the `Schema` suffix, the inferred type the bare name — the same
// convention as the rest of contracts/ (and it keeps base eslint no-redeclare
// happy, which can't see TS's value/type namespace split).
export const NoAddrSchema = z.object({});
export const NoBodySchema = z.object({});
export type NoAddr = z.infer<typeof NoAddrSchema>;
export type NoBody = z.infer<typeof NoBodySchema>;

export interface CommandRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body?: unknown;
}

// Build the wire request for a command. Shared by every client (CLI/MCP/web):
// they each own the fetch, but never the method/path/body assembly. GET/DELETE
// carry no body. Typed by the def, so a wrong-shaped call fails at compile time.
export function commandRequest<Addr, Data, Out>(
  def: CommandDef<Addr, Data, Out>,
  addr: Addr,
  data: Data,
): CommandRequest {
  const path = def.buildPath(addr);
  if (def.method === "GET" || def.method === "DELETE") return { method: def.method, path };
  return { method: def.method, path, body: data };
}
