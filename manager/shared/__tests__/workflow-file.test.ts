import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkflowFile, validateWorkflowDoc } from "../workflow-file.ts";

const graphJson = JSON.stringify({
  name: "flow",
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
});

const treeJson = JSON.stringify({ name: "audit", root: { type: "step", id: "s1", prompt: "scan" } });

describe("workflow-file — validate (zero LLM, zero daemon)", () => {
  it("accepts a valid v2 graph .json file", () => {
    const r = loadWorkflowFile(graphJson, true);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, "graph");
      assert.equal(r.name, "flow");
      assert.equal((r.def as { version?: number }).version, 2);
    }
  });

  it("accepts a valid v1 tree .json file", () => {
    const r = loadWorkflowFile(treeJson, true);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, "tree");
      assert.equal(r.name, "audit");
    }
  });

  it("accepts a v2 graph authored as .md (YAML frontmatter), folding body into description", () => {
    const md = "---\nname: mdflow\nversion: 2\nnodes:\n  - { id: in, kind: input }\n  - { id: out, kind: output }\nedges:\n  - { from: { node: in }, to: { node: out } }\n---\nA markdown graph.\n";
    const r = loadWorkflowFile(md, false);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, "graph");
      assert.equal((r.def as { description?: string }).description, "A markdown graph.");
    }
  });

  it("reports a precise error for an invalid v2 graph (self-edge)", () => {
    const bad = JSON.stringify({
      name: "bad", version: 2,
      nodes: [{ id: "in", kind: "input" }, { id: "w", kind: "worker" }, { id: "out", kind: "output" }],
      edges: [
        { from: { node: "in" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "out" } },
      ],
    });
    const r = loadWorkflowFile(bad, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /self-edges are not allowed|connects node "w" to itself/.test(e)), r.errors.join(" | "));
  });

  it("reports a precise error for a v2 graph missing an output node", () => {
    const bad = JSON.stringify({ name: "bad", version: 2, nodes: [{ id: "in", kind: "input" }], edges: [] });
    const r = validateWorkflowDoc(JSON.parse(bad));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /output.*node/.test(e)), r.errors.join(" | "));
  });

  it("reports invalid JSON instead of throwing", () => {
    const r = loadWorkflowFile("not json{", true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /invalid JSON/.test(e)));
  });

  it("rejects a v1 tree with no root, naming the missing field", () => {
    const r = loadWorkflowFile(JSON.stringify({ name: "x" }), true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => /root/.test(e)), r.errors.join(" | "));
  });
});
