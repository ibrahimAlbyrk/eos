import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesToolPattern, matchesAny } from "../domain/tool-glob.ts";

describe("matchesToolPattern — name globs", () => {
  it("exact name match", () => {
    assert.equal(matchesToolPattern("Bash", "Bash"), true);
    assert.equal(matchesToolPattern("Edit", "Bash"), false);
  });
  it("'*' matches everything", () => {
    assert.equal(matchesToolPattern("anything", "*"), true);
  });
  it("prefix globs (mcp__* / mcp__github__*)", () => {
    assert.equal(matchesToolPattern("mcp__github__create_pr", "mcp__*"), true);
    assert.equal(matchesToolPattern("mcp__github__create_pr", "mcp__github__*"), true);
    assert.equal(matchesToolPattern("mcp__slack__post", "mcp__github__*"), false);
    assert.equal(matchesToolPattern("Bash", "mcp__*"), false);
  });
  it("a name glob ignores the argument", () => {
    assert.equal(matchesToolPattern("Bash", "Bash", "git push origin"), true);
  });
});

describe("matchesToolPattern — command-scoped (Claude Code style)", () => {
  it("'Name(prefix:*)' matches the prefix at a token boundary", () => {
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", "git push"), true);
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", "git push origin main"), true);
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", "git status"), false);
    // token boundary: "git pushx" must NOT match "git push:*"
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", "git pushx"), false);
  });
  it("leading/trailing whitespace in the command is trimmed", () => {
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", "  git push origin  "), true);
  });
  it("exact inner spec (no wildcard)", () => {
    assert.equal(matchesToolPattern("Bash", "Bash(npm test)", "npm test"), true);
    assert.equal(matchesToolPattern("Bash", "Bash(npm test)", "npm test -- --watch"), false);
  });
  it("the name part must match the tool name", () => {
    assert.equal(matchesToolPattern("Edit", "Bash(git push:*)", "git push"), false);
  });
  it("a command-scoped pattern never matches a call with no argument", () => {
    assert.equal(matchesToolPattern("Bash", "Bash(git push:*)", undefined), false);
  });
});

describe("matchesAny", () => {
  it("denylist: only the scoped command is matched, the rest of Bash is free", () => {
    const deny = ["Bash(git push:*)"];
    assert.equal(matchesAny("Bash", deny, "git push origin"), true);
    assert.equal(matchesAny("Bash", deny, "git status"), false);
    assert.equal(matchesAny("Read", deny, undefined), false);
  });
});
