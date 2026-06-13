// MCP tool descriptions are authored as prompt fragments (prompts/tool/<name>)
// and rendered from the prompt system at MCP-server startup, then injected at
// registration — the description text never lives inline in the tool module.
// withToolDescriptions wraps the McpServer so registerTool pulls the description
// from the rendered map; tool-name refs inside descriptions resolve via the
// same TOOL_NAME_VARS globals as the role prompts.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FilePromptSource } from "../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../core/src/services/PromptRegistry.ts";
import { PromptService } from "../core/src/services/PromptService.ts";
import { TOOL_NAME_VARS } from "./prompt-tool-names.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };

export async function renderToolDescriptions(
  promptsDir: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const svc = new PromptService(
    new PromptRegistry(new FilePromptSource([promptsDir]), noopLog as never),
    [],
    TOOL_NAME_VARS,
  );
  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = (await svc.render(`tool/${name}`)).trim();
    } catch (e) {
      // Missing/broken description must not crash the MCP server — fall back to
      // the bare name (a degraded but functional tool) and log to stderr (stdout
      // is the MCP protocol channel).
      process.stderr.write(`[mcp] tool description unavailable for "${name}": ${e instanceof Error ? e.message : String(e)}\n`);
      out[name] = name;
    }
  }
  return out;
}

export function withToolDescriptions(server: McpServer, descriptions: Record<string, string>): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (name: string, config: Record<string, unknown>, handler: unknown) =>
          (target.registerTool as never)(name, { ...config, description: descriptions[name] ?? name }, handler);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;
}
