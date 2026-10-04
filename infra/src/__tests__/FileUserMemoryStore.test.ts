import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileUserMemoryStore, parseUserMemory, serializeUserMemory } from "../persistence/FileUserMemoryStore.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";

const MEM: UserMemory = {
  id: "um-abc12345",
  text: "Never run `eos build` while developing — it kills running workers.",
  category: "work-style",
  scope: { kind: "project", path: "/Users/me/eos" },
  tier: "on-demand",
  status: "suggested",
  source: { kind: "agent", agentId: "w-1", agentName: "stream", why: "said it twice" },
  rev: 2,
  createdAt: 1,
  updatedAt: 2,
};

describe("FileUserMemoryStore", () => {
  it("round-trips a memory through its markdown file", () => {
    assert.deepEqual(parseUserMemory(serializeUserMemory(MEM)), MEM);
    assert.match(serializeUserMemory(MEM), /\n---\nNever run `eos build`/);
  });

  it("persists, reloads, and soft-deletes to .trash", () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    new FileUserMemoryStore(dir).put(MEM);
    const reloaded = new FileUserMemoryStore(dir);
    assert.deepEqual(reloaded.get(MEM.id), MEM);
    assert.ok(reloaded.remove(MEM.id));
    assert.equal(reloaded.remove(MEM.id), false);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".md")), []);
    assert.equal(readdirSync(join(dir, ".trash")).length, 1);
  });

  it("skips files that don't parse or don't match their name", () => {
    const dir = mkdtempSync(join(tmpdir(), "memories-"));
    writeFileSync(join(dir, "um-broken000.md"), "no frontmatter");
    writeFileSync(join(dir, "um-other0000.md"), serializeUserMemory(MEM));
    assert.deepEqual(new FileUserMemoryStore(dir).list(), []);
    assert.ok(readFileSync(join(dir, "um-broken000.md"), "utf8"));
  });
});
