import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../../shared/mcp-tool.ts";

export const listPeersTool: McpToolModule = {
  name: "list_peers",
  register(server, session): void {
    server.registerTool(
      "list_peers",
      { inputSchema: {} },
      async () =>
        safeText(async () => {
          return await session.api("GET", `/workers/${session.selfId}/peers`);
        }),
    );
  },
};
