import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeScriptRunner } from "../workflow/NodeScriptRunner.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nsr-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Write an executable script (shebang + 0o755) into the allowlisted dir.
function script(name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
}

function runner(timeoutMs = 5000): NodeScriptRunner {
  return new NodeScriptRunner({ scriptDirs: [dir], defaultCwd: dir, defaultTimeoutMs: timeoutMs });
}

describe("NodeScriptRunner (§ITEM 1)", () => {
  it("runs an allowlisted script, feeds inputJson on stdin + EOS_NODE_INPUT, captures stdout/exit", async () => {
    script("echo.sh", "#!/bin/sh\nread STDIN_LINE\necho \"env=$EOS_NODE_INPUT stdin=$STDIN_LINE\"\n");
    const res = await runner().run({ script: "echo.sh", inputJson: '{"hi":1}', args: [] });
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /env=\{"hi":1\}/);
    assert.match(res.stdout, /stdin=\{"hi":1\}/);
  });

  it("passes argv after the script", async () => {
    script("args.sh", "#!/bin/sh\necho \"$1-$2\"\n");
    const res = await runner().run({ script: "args.sh", inputJson: "", args: ["a", "b"] });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout.trim(), "a-b");
  });

  it("surfaces a nonzero exit + stderr without throwing", async () => {
    script("fail.sh", "#!/bin/sh\necho oops 1>&2\nexit 3\n");
    const res = await runner().run({ script: "fail.sh", inputJson: "", args: [] });
    assert.equal(res.exitCode, 3);
    assert.match(res.stderr, /oops/);
  });

  it("kills on timeout and returns a nonzero exit (never hangs)", async () => {
    script("slow.sh", "#!/bin/sh\nsleep 10\n");
    const res = await runner(150).run({ script: "slow.sh", inputJson: "", args: [] });
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /timed out/);
  });

  it("rejects a name that is not in the allowlist (no exec)", async () => {
    const res = await runner().run({ script: "nope.sh", inputJson: "", args: [] });
    assert.equal(res.exitCode, 126);
    assert.match(res.stderr, /allowlisted/);
  });

  it("rejects path-traversal and absolute paths (the trust boundary)", async () => {
    const traversal = await runner().run({ script: "../escape.sh", inputJson: "", args: [] });
    assert.equal(traversal.exitCode, 126);
    const absolute = await runner().run({ script: "/bin/sh", inputJson: "", args: [] });
    assert.equal(absolute.exitCode, 126);
  });
});
