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

// A minimal, structurally-valid v2 node graph (input → transform → output).
function graphDef(name: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    description: `${name} graph`,
    version: 2,
    nodes: [
      { id: "in", kind: "input" },
      { id: "len", kind: "transform", config: { fn: "length", over: "{{args.items}}" } },
      { id: "out", kind: "output" },
    ],
    edges: [
      { from: { node: "in" }, to: { node: "len" } },
      { from: { node: "len" }, to: { node: "out" } },
    ],
    ...over,
  });
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

  it("loads a v2 node-graph file (version:2), validated against the graph schema", () => {
    const dir = join(root, "user");
    write(dir, "graph.json", graphDef("flow"));

    const recs = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list();
    assert.equal(recs.length, 1);
    const rec = recs[0] as { name: string; version?: number; source: string; nodes?: unknown[]; edges?: unknown[] };
    assert.equal(rec.name, "flow");
    assert.equal(rec.version, 2);
    assert.equal(rec.source, "user");
    assert.equal(rec.nodes?.length, 3);
    assert.equal(rec.edges?.length, 2);
  });

  it("loads a v2 graph from a .md file (YAML frontmatter), folding body into description", () => {
    const dir = join(root, "user");
    write(
      dir,
      "graph.md",
      "---\nname: mdflow\nversion: 2\nnodes:\n  - { id: in, kind: input }\n  - { id: out, kind: output }\nedges:\n  - { from: { node: in }, to: { node: out } }\n---\nA graph authored in markdown.\n",
    );

    const recs = new FileWorkflowDefinitionSource([{ dir, source: "project" }]).list();
    assert.equal(recs.length, 1);
    const rec = recs[0] as { name: string; version?: number; description?: string };
    assert.equal(rec.name, "mdflow");
    assert.equal(rec.version, 2);
    assert.equal(rec.description, "A graph authored in markdown.");
  });

  it("skips a structurally-INVALID v2 graph (e.g. a self-edge) but keeps the rest", () => {
    const dir = join(root, "user");
    write(dir, "good.json", graphDef("good"));
    // a self-edge — rejected by WorkflowGraphSchema, so this file is dropped
    write(dir, "bad.json", graphDef("bad", {
      nodes: [
        { id: "in", kind: "input" },
        { id: "w", kind: "worker" },
        { id: "out", kind: "output" },
      ],
      edges: [
        { from: { node: "in" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "out" } },
      ],
    }));
    write(dir, "tree.json", jsonDef("tree"));

    const names = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list().map((r) => r.name).sort();
    assert.deepEqual(names, ["good", "tree"], "valid graph + v1 tree load; the invalid graph is skipped");
  });

  it("v1 trees and v2 graphs coexist in one catalog", () => {
    const dir = join(root, "user");
    write(dir, "tree.json", jsonDef("a-tree"));
    write(dir, "graph.json", graphDef("z-graph"));

    const recs = new FileWorkflowDefinitionSource([{ dir, source: "user" }]).list();
    const byName = new Map(recs.map((r) => [r.name, r]));
    assert.equal((byName.get("a-tree") as { root?: unknown }).root !== undefined, true, "v1 tree keeps its root");
    assert.equal((byName.get("z-graph") as { version?: number }).version, 2, "v2 graph keeps version:2");
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
