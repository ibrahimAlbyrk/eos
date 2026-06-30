// Built-in tool descriptions come from the prompt system, not inline strings. Every
// BUILTIN_TOOL_NAMES entry must render a non-empty description from its
// manager/prompts/tool/<Name> fragment (via the SAME renderToolDescriptions loader the
// control tools use), and the assembled built-in surface must carry those rendered
// descriptions (still bare-name-keyed) — the item-level analog of withToolDescriptions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { BUILTIN_TOOL_NAMES } from "../../contracts/src/builtin-tools.ts";
import { renderToolDescriptions } from "../tool-descriptions.ts";
import { buildBuiltinSurface, buildLaneSurface, type LaneTooling } from "../backends/lane-tooling.ts";
import { createBuiltinToolRegistry } from "../../infra/src/tools/builtins/registry.ts";
import { createNodeToolFileSystem } from "../../infra/src/tools/NodeToolFileSystem.ts";
import { createNodeProcessRunner } from "../../infra/src/tools/NodeProcessRunner.ts";

const promptsDir = join(import.meta.dirname, "..", "prompts");
const registry = createBuiltinToolRegistry({ fs: createNodeToolFileSystem(), proc: createNodeProcessRunner() });
const emptyControl = (): LaneTooling => ({ items: [], tools: new Map() });

describe("built-in tool descriptions — sourced from the prompt library", () => {
  it("every BUILTIN_TOOL_NAMES entry renders a non-empty description from its tool/<Name> fragment", () => {
    const names = [...new Set(Object.values(BUILTIN_TOOL_NAMES))];
    const d = renderToolDescriptions(promptsDir, names);
    for (const name of names) {
      assert.ok(d[name] && d[name].length > 0, `${name} has a description`);
      // A real fragment was found, NOT the bare-name fallback renderToolDescriptions
      // returns when a tool/<Name> prompt is missing.
      assert.notEqual(d[name], name, `${name} resolved from its fragment, not the bare-name fallback`);
      assert.doesNotMatch(d[name], /\{\{/, `${name} has no unresolved {{var}}`);
      assert.doesNotMatch(d[name], /\$\{/, `${name} has no leftover \${...} canonical template var`);
    }
  });

  it("the built-in surface items carry the rendered descriptions (bare-name-keyed)", () => {
    const d = renderToolDescriptions(promptsDir, [...registry.list().map((t) => t.name), "Task"]);
    const surface = buildBuiltinSurface(registry, { cwd: "/repo", isOrchestrator: false }, d);
    assert.ok(surface.items.length > 0, "the surface offers built-ins");
    for (const item of surface.items) {
      assert.equal(item.description, d[item.name], `${item.name} item carries its rendered description`);
      assert.notEqual(item.description, item.name, `${item.name} is not the bare-name fallback`);
    }
  });

  it("the Task surface item carries its rendered description", () => {
    const d = renderToolDescriptions(promptsDir, [...registry.list().map((t) => t.name), "Task"]);
    const lane = buildLaneSurface(registry, emptyControl(), { cwd: "/repo", isOrchestrator: false }, d);
    const task = lane.items.find((i) => i.name === "Task");
    assert.ok(task, "a non-orchestrator surface offers Task");
    assert.equal(task!.description, d.Task);
    assert.notEqual(task!.description, "Task");
  });

  it("falls back to the bare name when no descriptions map is passed (back-compat)", () => {
    const surface = buildBuiltinSurface(registry, { cwd: "/repo", isOrchestrator: false });
    for (const item of surface.items) assert.equal(item.description, item.name);
  });
});
