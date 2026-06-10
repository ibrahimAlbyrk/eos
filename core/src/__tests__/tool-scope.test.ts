import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEosControlTool } from "../domain/tool-scope.ts";

describe("isEosControlTool", () => {
  it("matches tools of every builtin server", () => {
    assert.equal(isEosControlTool("mcp__orchestrator__spawn_worker"), true);
    assert.equal(isEosControlTool("mcp__worker__send_message_to_parent"), true);
    assert.equal(isEosControlTool("mcp__gateway__decide"), true);
  });

  it("ignores user MCP servers and native tools", () => {
    assert.equal(isEosControlTool("mcp__context7__query-docs"), false);
    assert.equal(isEosControlTool("Bash"), false);
    assert.equal(isEosControlTool("spawn_worker"), false);
  });

  it("requires the full mcp__<server>__ prefix", () => {
    assert.equal(isEosControlTool("mcp__orchestratorx__spawn_worker"), false);
    assert.equal(isEosControlTool("mcp__orchestrator"), false);
  });
});
