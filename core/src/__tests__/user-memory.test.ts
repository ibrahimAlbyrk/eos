import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicateMemory, memoriesInScope, memorySimilarity, scopeCovers, searchMemories,
} from "../domain/user-memory.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";

let seq = 0;
function mem(text: string, over: Partial<UserMemory> = {}): UserMemory {
  seq += 1;
  return {
    id: `um-mem${String(seq).padStart(5, "0")}`, text, category: "work-style", scope: { kind: "global" },
    tier: "always", status: "active", source: { kind: "user" }, rev: 0, createdAt: seq, updatedAt: seq, ...over,
  };
}

const EOS = { kind: "project" as const, path: "/Users/me/eos" };

describe("user memory domain", () => {
  it("project scope covers the folder and below, nothing else", () => {
    assert.ok(scopeCovers(EOS, "/Users/me/eos"));
    assert.ok(scopeCovers(EOS, "/Users/me/eos/app/ui"));
    assert.ok(!scopeCovers(EOS, "/Users/me/eos-old"));
    assert.ok(!scopeCovers(EOS, null));
    assert.ok(scopeCovers({ kind: "global" }, null));
  });

  it("only kept memories are in scope", () => {
    const kept = mem("a b");
    const pending = mem("c d", { status: "suggested" });
    assert.deepEqual(memoriesInScope([kept, pending], null), [kept]);
  });

  it("similarity ignores case, order and punctuation", () => {
    assert.equal(memorySimilarity("Be concise, always.", "always be CONCISE"), 1);
    assert.ok(memorySimilarity("Use tabs", "Use spaces") < 0.8);
  });

  it("duplicates match within the same scope, and globals cover projects", () => {
    const global = mem("Write commits in English.");
    const other = mem("Run lint before tests.", { scope: { kind: "project", path: "/x" } });
    assert.equal(findDuplicateMemory("write commits in english", EOS, [global, other]), global);
    assert.equal(findDuplicateMemory("Run lint before tests", EOS, [global, other]), null);
    assert.equal(findDuplicateMemory("Run lint before tests", { kind: "project", path: "/x" }, [other]), other);
  });

  it("search ranks by query words, respects scope, lists newest for an empty query", () => {
    const a = mem("Prefers pnpm over npm.");
    const b = mem("Commit messages in English, terse.");
    const c = mem("Never restart the daemon.", { scope: EOS });
    const d = mem("Pending npm thing.", { status: "suggested" });
    assert.deepEqual(searchMemories([a, b, c, d], "npm commit", null, 5), [b, a].sort((x, y) => y.updatedAt - x.updatedAt));
    assert.deepEqual(searchMemories([a, b, c], "restart daemon", null, 5), []);
    assert.deepEqual(searchMemories([a, b, c], "restart daemon", "/Users/me/eos", 5), [c]);
    assert.deepEqual(searchMemories([a, b, c], "", "/Users/me/eos", 2), [c, b]);
  });
});
