// Registration fingerprint: capture each module's registered inputSchema as a
// stable JSON schema (pre-description). The legacy McpToolModule and the new
// ToolDefinition projection share the same register(server, session) interface,
// so both can be fingerprinted identically — the proof that the refactor is
// byte-identical. Descriptions are injected by withToolDescriptions from the
// unchanged prompt library, so they're out of scope here; only schemas move.

import { z } from "zod";
import type { ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface RegisterLike<S> {
  readonly name: string;
  register(server: McpServer, session: S): void;
}

export function fingerprintModules<S>(modules: ReadonlyArray<RegisterLike<S>>, session: S): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const recording = {
    registerTool(name: string, config: { inputSchema?: ZodRawShape }) {
      out[name] = zodToJsonSchema(z.object(config.inputSchema ?? {}));
    },
  } as unknown as McpServer;
  for (const m of modules) m.register(recording, session);
  return out;
}

export const FAKE_ORCH_SESSION = {
  selfId: "orch-1",
  daemonUrl: "http://127.0.0.1:7400",
  cwd: "/repo",
  isGitRepo: () => true,
  api: async () => ({}),
};

export const FAKE_WORKER_SESSION = {
  selfId: "w-1",
  daemonUrl: "http://127.0.0.1:7400",
  collaborate: true,
  api: async () => ({}),
};
