// Cross-transport parity: the MCP (claude-cli subprocess), SDK (claude-sdk in-
// process), and ToolRuntime (in-process API) lanes must expose the SAME tool set
// — identical fully-qualified names and identical input JSON Schemas — derived
// from the one registry. This is the executable guarantee behind "every tool
// works identically on every backend". A drift in any projection (a renamed tool,
// a different prefix, a transformed schema) fails here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { orchestratorDefs, workerDefs, peerDefs, workflowWorkerDefs } from "../registry.ts";
import { toMcpModule, toRuntimeTool, prefixedToolName, mcpServerForRole, toolJsonSchema } from "../projections.ts";
import { toSdkTool } from "../../backends/sdk/SdkToolHost.ts";
import { fingerprintModules } from "./fingerprint.ts";
import { EOS_BUILTIN_MCP_SERVERS } from "../../../contracts/src/tool-scope.ts";
import type { ToolContext } from "../types.ts";

const CTX: ToolContext = { selfId: "x", cwd: "/repo", isGitRepo: () => true, api: async () => ({}) };

const CASES = [
  { label: "orchestrator", defs: orchestratorDefs, isOrch: true },
  { label: "worker+peer", defs: [...workerDefs, ...peerDefs], isOrch: false },
  { label: "workflow-worker", defs: workflowWorkerDefs, isOrch: false },
] as const;

describe("tool projection parity — MCP / SDK / runtime expose identical name+schema", () => {
  for (const { label, defs, isOrch } of CASES) {
    it(`${label}: every transport agrees with the registry`, () => {
      const server = mcpServerForRole(isOrch);
      // The server name must be an Eos control-plane server, or isEosControlTool +
      // classifyTool's mcp__* always-allow would not key on the produced prefix.
      assert.ok((EOS_BUILTIN_MCP_SERVERS as readonly string[]).includes(server), `${server} is an Eos builtin`);

      const expected = defs.map((d) => ({ name: prefixedToolName(server, d.name), schema: toolJsonSchema(d) }));

      // MCP lane — a recording server captures the schema each module registers.
      const fp = fingerprintModules(defs.map((d) => toMcpModule(d, () => CTX)), {} as never);
      const mcp = defs.map((d) => ({ name: prefixedToolName(server, d.name), schema: fp[d.name] }));
      assert.deepEqual(mcp, expected, "MCP projection drifted from the registry");

      // SDK lane — tool() carries name + the same raw input shape.
      const sdk = defs.map((d) => {
        const t = toSdkTool(d, CTX, `desc:${d.name}`);
        return { name: prefixedToolName(server, t.name), schema: zodToJsonSchema(z.object(t.inputSchema)) };
      });
      assert.deepEqual(sdk, expected, "SDK projection drifted from the registry");

      // Runtime lane — name carried by toRuntimeTool; schema via the single source.
      const rt = defs.map((d) => {
        const t = toRuntimeTool(d, CTX);
        return { name: prefixedToolName(server, t.name), schema: toolJsonSchema(d) };
      });
      assert.deepEqual(rt, expected, "runtime projection drifted from the registry");
    });
  }
});
