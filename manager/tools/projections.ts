// Transport projections (Adapter pattern). One ToolDefinition -> the wire shape
// each backend needs, plus the SINGLE source for a tool's fully-qualified name
// (mcp__<server>__<tool>) and input JSON Schema, so every lane agrees byte-for-byte
// (locked by projection-parity.test.ts). toSdkTool deliberately stays in the SDK
// backend (SdkToolHost) so this module — loaded inside the claude-cli MCP
// subprocess — never pulls @anthropic-ai/claude-agent-sdk into that subprocess.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeTool } from "../../core/src/use-cases/ToolRuntime.ts";
import { safeText } from "../shared/mcp-tool.ts";
import type { ToolDefinition, ToolContext } from "./types.ts";

// The MCP server a role's tools are hosted under: orchestrator tools on
// "orchestrator", worker + peer tools on "worker" (both EOS_BUILTIN_MCP_SERVERS
// entries, so isEosControlTool + classifyTool's mcp__* always-allow key on the
// resulting prefix). Single source for the server name across every transport.
export function mcpServerForRole(isOrchestrator: boolean): string {
  return isOrchestrator ? "orchestrator" : "worker";
}

// Fully-qualified tool name every transport must expose.
export function prefixedToolName(server: string, name: string): string {
  return `mcp__${server}__${name}`;
}

// Canonical JSON Schema for a tool's input — the one derivation every lane uses.
export function toolJsonSchema(def: ToolDefinition): Record<string, unknown> {
  return zodToJsonSchema(z.object(def.inputSchema)) as Record<string, unknown>;
}

// Structurally the legacy McpToolModule<S>: { name, register(server, session) }.
export interface McpProjection<S> {
  readonly name: string;
  register(server: McpServer, session: S): void;
}

// Lane: claude-cli MCP subprocess. Byte-identical to the legacy modules —
// server.registerTool(name, { inputSchema }, safeText-wrapped handler); the
// description is injected by the withToolDescriptions proxy at registration.
export function toMcpModule<S>(def: ToolDefinition, makeCtx: (session: S) => ToolContext): McpProjection<S> {
  return {
    name: def.name,
    register(server, session) {
      const ctx = makeCtx(session);
      server.registerTool(
        def.name,
        { inputSchema: def.inputSchema },
        async (args) => safeText(() => def.handler(ctx, args as Record<string, unknown>)),
      );
    },
  };
}

// Lane: in-process Eos ToolRuntime (anthropic-api / openai / deepseek / kimi).
// Mirrors safeText's string/JSON contract so the model sees identical tool text;
// ToolRuntime.executeGated owns error -> isError (a throw propagates to it).
export function toRuntimeTool(def: ToolDefinition, ctx: ToolContext): RuntimeTool {
  return {
    name: def.name,
    async execute(input) {
      const res = await def.handler(ctx, input);
      return typeof res === "string" ? res : JSON.stringify(res, null, 2);
    },
  };
}
