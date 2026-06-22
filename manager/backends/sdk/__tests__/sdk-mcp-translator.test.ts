import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toSdkMcpServers } from "../SdkMcpTranslator.ts";

describe("toSdkMcpServers — resolved map -> SDK McpServerConfig union", () => {
  it("stdio passthrough with type omitted emits type:'stdio'", () => {
    const { mcpServers, dropped } = toSdkMcpServers({
      ctx7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { K: "v" } },
    });
    assert.deepEqual(dropped, []);
    assert.deepEqual(mcpServers.ctx7, { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { K: "v" } });
  });

  it("sse and http pass through; streamable-http is rewritten to http", () => {
    const { mcpServers, dropped } = toSdkMcpServers({
      a: { type: "sse", url: "https://a/sse", headers: { Authorization: "Bearer x" } },
      b: { type: "http", url: "https://b/mcp" },
      c: { type: "streamable-http", url: "https://c/mcp" },
    });
    assert.deepEqual(dropped, []);
    assert.deepEqual(mcpServers.a, { type: "sse", url: "https://a/sse", headers: { Authorization: "Bearer x" } });
    assert.deepEqual(mcpServers.b, { type: "http", url: "https://b/mcp" });
    assert.deepEqual(mcpServers.c, { type: "http", url: "https://c/mcp" }); // alias normalized
  });

  it("passes an in-process Eos instance through unchanged", () => {
    const sdkInstance = { type: "sdk", name: "worker", instance: { _server: {} } };
    const { mcpServers, dropped } = toSdkMcpServers({ worker: sdkInstance });
    assert.deepEqual(dropped, []);
    assert.equal(mcpServers.worker, sdkInstance); // same reference, not rebuilt
  });

  it("drops claude.ai-connector / unknown / null / string with a reason, never throws", () => {
    const { mcpServers, dropped } = toSdkMcpServers({
      connector: { type: "claudeai-proxy", url: "https://x" },
      weird: { foo: "bar" },
      nil: null,
      str: "not-an-object",
    });
    assert.deepEqual(Object.keys(mcpServers), []);
    assert.deepEqual(dropped.map((d) => d.name).sort(), ["connector", "nil", "str", "weird"]);
    assert.ok(dropped.every((d) => d.reason === "unsupported MCP server shape"));
  });

  it("does not propagate alwaysLoad onto external entries", () => {
    const { mcpServers } = toSdkMcpServers({
      x: { command: "node", alwaysLoad: true },
    });
    assert.equal("alwaysLoad" in (mcpServers.x as Record<string, unknown>), false);
  });
});
