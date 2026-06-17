// Transport projections (Adapter pattern). One ToolDefinition -> the wire shape
// each backend needs. toSdkTool (claude-sdk in-process server) is added in the
// SDK-backend phase, where @anthropic-ai/claude-agent-sdk is installed.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeTool } from "../../core/src/use-cases/ToolRuntime.ts";
import { safeText } from "../shared/mcp-tool.ts";
import type { ToolDefinition, ToolContext } from "./types.ts";

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
