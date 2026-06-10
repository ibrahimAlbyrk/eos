import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserTemplateService } from "../UserTemplateService.ts";

describe("UserTemplateService", () => {
  let dir: string;
  let svc: UserTemplateService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tpl-test-"));
    svc = new UserTemplateService(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists empty when dir does not exist", () => {
    const ghost = new UserTemplateService(join(dir, "missing"));
    assert.deepEqual(ghost.list(), []);
  });

  it("write + read roundtrips name, description, content", () => {
    svc.write({ name: "bug-fix", description: "repro & fix", content: "Fix {{file}}.\nRepro: {{steps}}" });
    const t = svc.read("bug-fix");
    assert.equal(t.name, "bug-fix");
    assert.equal(t.description, "repro & fix");
    assert.equal(t.content, "Fix {{file}}.\nRepro: {{steps}}");
  });

  it("write is an upsert and list sorts by name", () => {
    svc.write({ name: "b", description: "", content: "two" });
    svc.write({ name: "a", description: "", content: "one" });
    svc.write({ name: "b", description: "updated", content: "two-v2" });
    const names = svc.list().map((t) => t.name);
    assert.deepEqual(names, ["a", "b"]);
    assert.equal(svc.read("b").content, "two-v2");
    assert.equal(svc.read("b").description, "updated");
  });

  it("survives yaml-hostile descriptions", () => {
    const desc = `it's: "tricky" #yes`;
    svc.write({ name: "tricky", description: desc, content: "body" });
    assert.equal(svc.read("tricky").description, desc);
  });

  it("reads hand-written files without frontmatter", () => {
    writeFileSync(join(dir, "raw.md"), "just a prompt\n");
    const t = svc.read("raw");
    assert.equal(t.description, "");
    assert.equal(t.content, "just a prompt");
  });

  it("rejects invalid names", () => {
    assert.throws(() => svc.write({ name: "../escape", description: "", content: "x" }));
    assert.throws(() => svc.read("Has Spaces"));
    assert.throws(() => svc.delete("UPPER"));
  });

  it("delete moves the file to .trash and reports missing", () => {
    svc.write({ name: "gone", description: "", content: "x" });
    assert.equal(svc.delete("gone"), true);
    assert.equal(svc.delete("gone"), false);
    assert.deepEqual(svc.list(), []);
    const trashed = readdirSync(join(dir, ".trash"));
    assert.equal(trashed.length, 1);
    assert.ok(trashed[0].startsWith("gone."));
    assert.ok(trashed[0].endsWith(".md"));
  });

  it("written file is frontmatter + body markdown", () => {
    svc.write({ name: "fmt", description: "d", content: "body" });
    const raw = readFileSync(join(dir, "fmt.md"), "utf8");
    assert.ok(raw.startsWith("---\n"));
    assert.ok(raw.includes("description: d"));
    assert.ok(raw.endsWith("body\n"));
  });
});
