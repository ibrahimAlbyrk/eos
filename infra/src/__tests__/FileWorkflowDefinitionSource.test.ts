import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileWorkflowDefinitionSource,
  findProjectWorkflowDefinitionsDir,
} from "../workflow/FileWorkflowDefinitionSource.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fwf-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf8");
}

function jsonDef(name: string, prompt = "do it"): string {
  return JSON.stringify({ name, description: `${name} desc`, root: { type: "step", id: "s1", prompt } });
}

describe("FileWorkflowDefinitionSource", () => {
  it("reads a .json definition file and tags its provenance", () => {
    const dir = join(root, "user");
    write(dir, "review.json", jsonDef("review"));

    const recs = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].name, "review");
    assert.equal(recs[0].source, "user");
    assert.deepEqual(recs[0].root, { type: "step", id: "s1", prompt: "do it" });
  });

  it("reads a .md definition: YAML frontmatter is the def, body folds into description", () => {
    const dir = join(root, "user");
    write(
      dir,
      "audit.md",
      "---\nname: audit\nroot:\n  type: step\n  id: s1\n  prompt: scan\n---\nThe human-readable description.\n",
    );

    const recs = new FileWorkflowDefinitionSource([{ dir, source: "project" }]).list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].name, "audit");
    assert.equal(recs[0].description, "The human-readable description.");
    assert.deepEqual(recs[0].root, { type: "step", id: "s1", prompt: "scan" });
  });

  it("walks recursively and skips unreadable/invalid files instead of breaking the catalog", () => {
    const dir = join(root, "user");
    write(dir, "ok.json", jsonDef("ok"));
    write(join(dir, "nested"), "deep.json", jsonDef("deep"));
    write(dir, "garbage.json", "not json{");
    write(dir, "wrongshape.json", JSON.stringify({ description: "no name or root" }));
    write(dir, "ignored.txt", jsonDef("ignored"));

    const names = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list().map((r) => r.name).sort();
    assert.deepEqual(names, ["deep", "ok"]);
  });

  it("later directories override earlier ones by name (project shadows user)", () => {
    const userDir = join(root, "user");
    const projDir = join(root, "project");
    write(userDir, "review.json", jsonDef("review", "user prompt"));
    write(projDir, "review.json", jsonDef("review", "project prompt"));

    const recs = new FileWorkflowDefinitionSource([
      { dir: userDir, source: "user" },
      { dir: projDir, source: "project" },
    ]).list();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].source, "project");
    assert.deepEqual(recs[0].root, { type: "step", id: "s1", prompt: "project prompt" });
  });

  it("returns [] when a configured directory does not exist", () => {
    const recs = new FileWorkflowDefinitionSource([{ dir: join(root, "absent"), source: "user" }]).list();
    assert.deepEqual(recs, []);
  });

  it("findProjectWorkflowDefinitionsDir finds the nearest .eos/workflows walking up", () => {
    const proj = join(root, "proj");
    const wfDir = join(proj, ".eos", "workflows");
    mkdirSync(wfDir, { recursive: true });
    const deep = join(proj, "a", "b", "c");
    mkdirSync(deep, { recursive: true });

    assert.equal(findProjectWorkflowDefinitionsDir(deep), wfDir);
    assert.equal(findProjectWorkflowDefinitionsDir(join(root, "elsewhere")), null);
  });
});
