// Lane A tool host: project Eos ToolDefinitions onto in-process SDK tools
// (createSdkMcpServer runs them in the host process — no subprocess, no stdio).
// tool() accepts a zod-3 or zod-4 raw shape (AnyZodRawShape), so the same
// ToolDefinition.inputSchema as the MCP transport plugs in unchanged.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDefinition, ToolContext } from "../../tools/types.ts";
import { mcpServerForRole } from "../../tools/projections.ts";

// Kept here (not in tools/projections.ts) so the claude-cli MCP subprocess that
// loads projections.ts never imports @anthropic-ai/claude-agent-sdk. Exported for
// projection-parity.test.ts. tool() takes the same zod raw shape as the MCP +
// runtime lanes, so ToolDefinition.inputSchema plugs in unchanged.
export function toSdkTool(def: ToolDefinition, ctx: ToolContext, description: string) {
  return tool(def.name, description, def.inputSchema, async (args) => {
    const res = await def.handler(ctx, args as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] };
  });
}

export interface SdkToolHostDeps {
  readonly orchestratorDefs: readonly ToolDefinition[];
  readonly workerDefs: readonly ToolDefinition[];
  readonly peerDefs: readonly ToolDefinition[];
  readonly workflowWorkerDefs: readonly ToolDefinition[];
  /** Render the tool-name→description map fresh from the prompt library. Called
   *  ONCE per spawn (in buildSdkToolServers) so prompt-file edits take effect on
   *  the next spawn with no daemon restart — matching the claude-cli MCP lane. */
  renderDescriptions(): Record<string, string>;
}

export interface SdkToolHostInput {
  readonly isOrchestrator: boolean;
  readonly collaborate: boolean;
  readonly role?: string;
  readonly ctx: ToolContext;
}

// Server names MUST stay orchestrator/worker so tool names are
// mcp__orchestrator__*/mcp__worker__* (isEosControlTool + classifyTool key on the
// prefix). An orchestrator gets the orchestrator surface; a worker gets the worker
// surface (+ peer tools when collaborate) — mirroring the PTY MCP entrypoints.
//
// allowedTools is returned EMPTY by design: it is the SDK's auto-approve list, and
// an allow-listed tool bypasses canUseTool (and thus Eos's policy engine). Leaving
// Eos tools out keeps them OFFERED (via mcpServers) but routes every call through
// canUseTool → PolicyGatewayService — exactly the PTY hook-as-gateway posture.
export function buildSdkToolServers(
  deps: SdkToolHostDeps,
  input: SdkToolHostInput,
): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const server = mcpServerForRole(input.isOrchestrator);
  const defs = input.role === "workflow-worker"
    ? deps.workflowWorkerDefs
    : input.isOrchestrator
      ? deps.orchestratorDefs
      : (input.collaborate ? [...deps.workerDefs, ...deps.peerDefs] : deps.workerDefs);
  const descriptions = deps.renderDescriptions();
  const tools = defs.map((d) => toSdkTool(d, input.ctx, descriptions[d.name] ?? d.name));
  return {
    mcpServers: { [server]: createSdkMcpServer({ name: server, version: "1.0.0", tools }) },
    allowedTools: [],
  };
}
