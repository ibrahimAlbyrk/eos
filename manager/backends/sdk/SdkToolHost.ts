// Lane A tool host: project Eos ToolDefinitions onto in-process SDK tools
// (createSdkMcpServer runs them in the host process — no subprocess, no stdio).
// tool() accepts a zod-3 or zod-4 raw shape (AnyZodRawShape), so the same
// ToolDefinition.inputSchema as the MCP transport plugs in unchanged.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition, ToolContext } from "../../tools/types.ts";

function toSdkTool(def: ToolDefinition, ctx: ToolContext, description: string) {
  return tool(def.name, description, def.inputSchema, async (args) => {
    const res = await def.handler(ctx, args as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] };
  });
}

export interface SdkToolHostDeps {
  readonly orchestratorDefs: readonly ToolDefinition[];
  readonly workerDefs: readonly ToolDefinition[];
  readonly peerDefs: readonly ToolDefinition[];
  renderDescription(name: string): string;
}

export interface SdkToolHostInput {
  readonly isOrchestrator: boolean;
  readonly collaborate: boolean;
  readonly ctx: ToolContext;
}

// Server names MUST stay orchestrator/worker so tool names are
// mcp__orchestrator__*/mcp__worker__* (isEosControlTool + classifyTool key on the
// prefix). An orchestrator gets the orchestrator surface; a worker gets the worker
// surface (+ peer tools when collaborate) — mirroring the PTY MCP entrypoints.
export function buildSdkToolServers(
  deps: SdkToolHostDeps,
  input: SdkToolHostInput,
): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const mk = (defs: readonly ToolDefinition[]) => defs.map((d) => toSdkTool(d, input.ctx, deps.renderDescription(d.name)));
  if (input.isOrchestrator) {
    return {
      mcpServers: { orchestrator: createSdkMcpServer({ name: "orchestrator", version: "1.0.0", tools: mk(deps.orchestratorDefs) }) },
      allowedTools: deps.orchestratorDefs.map((d) => `mcp__orchestrator__${d.name}`),
    };
  }
  const wd = input.collaborate ? [...deps.workerDefs, ...deps.peerDefs] : deps.workerDefs;
  return {
    mcpServers: { worker: createSdkMcpServer({ name: "worker", version: "1.0.0", tools: mk(wd) }) },
    allowedTools: wd.map((d) => `mcp__worker__${d.name}`),
  };
}
