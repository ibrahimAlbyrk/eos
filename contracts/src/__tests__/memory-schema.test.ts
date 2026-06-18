import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemorySourceSchema } from "../memory.ts";

describe("MemorySourceSchema", () => {
  it("accepts a full source, a partial one, and an empty object (all fields optional)", () => {
    assert.equal(MemorySourceSchema.safeParse({
      enabled: true, label: "CLAUDE.md", userPaths: ["~/.claude/CLAUDE.md"],
      projectFilenames: ["CLAUDE.md"], priority: 0, assumeNativeFor: ["claude-cli"],
    }).success, true);
    assert.equal(MemorySourceSchema.safeParse({ projectFilenames: ["AGENTS.md"] }).success, true);
    assert.equal(MemorySourceSchema.safeParse({}).success, true);
  });

  it("rejects wrong field types", () => {
    assert.equal(MemorySourceSchema.safeParse({ userPaths: "CLAUDE.md" }).success, false);
    assert.equal(MemorySourceSchema.safeParse({ priority: "high" }).success, false);
    assert.equal(MemorySourceSchema.safeParse({ enabled: "yes" }).success, false);
    assert.equal(MemorySourceSchema.safeParse({ assumeNativeFor: [1, 2] }).success, false);
  });
});
