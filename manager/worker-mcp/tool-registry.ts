import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkerSession } from "./SessionContext.ts";

import { sendMessageToParentTool } from "./tools/send_message_to_parent.ts";

export interface McpToolModule {
  readonly name: string;
  register(server: McpServer, session: WorkerSession): void;
}

export const toolModules: McpToolModule[] = [
  sendMessageToParentTool,
];

export async function safeText<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const res = await fn();
    return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
      isError: true,
    };
  }
}
