import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveParentAgentToolUseId } from "../subagent-meta.ts";
import { encodeCwd } from "../worktree.ts";

const baseDir = mkdtempSync(join(tmpdir(), "cm-submeta-"));
const cwd = "/private/tmp/work";
const sid = "sess-1";

after(() => {
  try { rmSync(baseDir, { recursive: true, force: true }); } catch {}
});

function writeMeta(agentId: string, body: string): void {
  const dir = join(baseDir, encodeCwd(cwd), sid, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${agentId}.meta.json`), body);
}

describe("resolveParentAgentToolUseId", () => {
  it("returns the toolUseId from the meta file", () => {
    writeMeta("aid-1", JSON.stringify({ toolUseId: "toolu_X" }));
    assert.equal(resolveParentAgentToolUseId(cwd, sid, "aid-1", baseDir), "toolu_X");
  });

  it("returns null when the meta file is missing", () => {
    assert.equal(resolveParentAgentToolUseId(cwd, sid, "unknown-aid", baseDir), null);
  });

  it("returns null when the meta file is malformed JSON", () => {
    writeMeta("aid-bad", "{ not json");
    assert.equal(resolveParentAgentToolUseId(cwd, sid, "aid-bad", baseDir), null);
  });

  it("returns null when toolUseId is absent", () => {
    writeMeta("aid-empty", JSON.stringify({ other: 1 }));
    assert.equal(resolveParentAgentToolUseId(cwd, sid, "aid-empty", baseDir), null);
  });
});
