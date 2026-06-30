// RuntimeMcpClient — the embedded MCP client adapter, proven against a REAL
// @modelcontextprotocol/sdk server over an in-process linked transport (no
// subprocess, no network). Verifies the round-trip the in-process lane relies on:
// connect → tools/list (mapped to McpRemoteTool) → tools/call (content text
// extracted) → close. Plus the fail-soft contract: an unsupported server shape
// makes connect() throw, so resolveRuntimeMcpTools drops just that server.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntimeMcpClient } from "../mcp/RuntimeMcpClient.ts";

function fakeServer(): McpServer {
  const server = new McpServer({ name: "fake", version: "1" });
  server.registerTool(
    "echo",
    { description: "echo the input back", inputSchema: { v: z.number() } },
    async ({ v }) => ({ content: [{ type: "text", text: `echoed ${v}` }] }),
  );
  return server;
}

describe("RuntimeMcpClient — over a real SDK server (in-memory transport)", () => {
  it("connects, lists tools, calls a tool, and closes", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await fakeServer().connect(serverT);

    const client = createRuntimeMcpClient("fake", {}, { makeTransport: () => clientT });
    await client.connect();

    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    assert.equal(tools[0].description, "echo the input back");
    assert.ok(tools[0].inputSchema?.properties, "remote inputSchema is surfaced");

    const result = await client.callTool("echo", { v: 5 });
    assert.equal(result, "echoed 5");

    await client.close(); // best-effort, must not throw
  });

  it("connect() throws on an unsupported server shape (caller drops it, fail-soft)", async () => {
    const client = createRuntimeMcpClient("weird", { type: "claude-ai-connector" });
    await assert.rejects(() => client.connect(), /unsupported MCP server shape/);
    await client.close(); // no-op when never connected
  });
});
