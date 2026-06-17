// Transport-agnostic tool model. One ToolDefinition is projected onto three
// transports (Adapter pattern, see projections.ts): the claude-cli MCP subprocess
// (toMcpModule), the in-process claude-sdk server (toSdkTool, added with the SDK),
// and the in-process Eos ToolRuntime (toRuntimeTool). The definition carries no
// transport detail: a name, a Zod input shape, and a pure handler that returns a
// value (string passed through; objects JSON-stringified by each projection,
// mirroring the legacy safeText). Tool DESCRIPTIONS stay in the prompt library
// (prompts/tool/<name>) and are injected per transport — never inline here.

import type { ZodRawShape } from "zod";

export type ToolVisibility = "orchestrator" | "worker" | "peer";

// The session-bound execution seam a tool handler runs against. Identity is
// per-worker (selfId/cwd), never process-global, so one set of definitions can
// serve many in-process workers concurrently. `api` dispatches a daemon
// operation — HTTP for the MCP subprocess, HTTP-loopback / in-process for the
// SDK + runtime backends. cwd/isGitRepo are meaningful only for the orchestrator
// (spawn_worker); worker contexts supply inert values (no worker tool reads them).
export interface ToolContext {
  readonly selfId: string;
  readonly cwd: string;
  isGitRepo(): boolean;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly visibility: ToolVisibility;
  readonly inputSchema: ZodRawShape;
  handler(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}
