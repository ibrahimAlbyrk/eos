import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeArgs } from "../claude-args.ts";
import type { WorkerOptions } from "../options.ts";

function opts(over: Partial<WorkerOptions>): WorkerOptions {
  return { prompt: "", model: "opus", ...over } as WorkerOptions;
}

const ENV = {};

describe("buildClaudeArgs positional boot prompt", () => {
  it("appends the prompt as the last arg, after a -- option terminator", () => {
    const { args } = buildClaudeArgs(opts({ prompt: "do the thing" }), "/tmp", "/tmp/s.json", ENV);
    assert.deepEqual(args.slice(-2), ["--", "do the thing"]);
  });

  it("preserves multi-line text and special characters verbatim (one argv element)", () => {
    const p = "line1\nline2 — \"q\" → end\twith\ttabs";
    const { args } = buildClaudeArgs(opts({ prompt: p }), "/tmp", "/tmp/s.json", ENV);
    assert.equal(args[args.length - 1], p);
  });

  it("omits the positional (and --) when the prompt is empty or whitespace", () => {
    const empty = buildClaudeArgs(opts({ prompt: "" }), "/tmp", "/tmp/s.json", ENV).args;
    assert.ok(!empty.includes("--"));
    const ws = buildClaudeArgs(opts({ prompt: "   \n " }), "/tmp", "/tmp/s.json", ENV).args;
    assert.ok(!ws.includes("--"));
  });

  it("places the prompt after all flags so a leading-dash prompt is not parsed as a flag", () => {
    const { args } = buildClaudeArgs(
      opts({ prompt: "-rf danger", effort: "max", claudePermissionMode: "acceptEdits", resumeSessionId: "sess-1" }),
      "/tmp", "/tmp/s.json", ENV,
    );
    const dd = args.indexOf("--");
    assert.ok(args.indexOf("--model") < dd && args.indexOf("--resume") < dd);
    assert.equal(dd, args.length - 2);
    assert.equal(args[args.length - 1], "-rf danger");
  });

  it("withholds the positional when an Eos tool MCP is expected (mcp-init race guard)", () => {
    // parentId + workerId, no --mcp-config → synthetic worker MCP path →
    // expectsMcpReady is true, so worker.ts owns delivery and the prompt must
    // NOT be auto-submitted via argv (it would race the MCP connect).
    const dir = mkdtempSync(join(tmpdir(), "eos-claudeargs-"));
    const { args } = buildClaudeArgs(
      opts({ prompt: "do the thing", workerId: "w-1", parentId: "o-1" }),
      dir, join(dir, "s.json"), ENV,
    );
    assert.ok(!args.includes("--"), "no -- option terminator");
    assert.ok(!args.includes("do the thing"), "prompt not present as an argv positional");
  });
});
