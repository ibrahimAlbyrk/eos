import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDefinitionName, resolveWorkerDefinitionByName, splitProviderModel } from "../domain/worker-definition-resolution.ts";
import { DEFAULT_WORKER_DEFINITION } from "../../../contracts/src/worker-definition.ts";
import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

describe("splitProviderModel — combined provider/model form", () => {
  const configured = new Set(["deepseek", "kimi"]);

  it("splits a configured-prefix model into backendProfile + model (rest after first /)", () => {
    assert.deepEqual(
      splitProviderModel("deepseek/deepseek-v4-pro", configured),
      { backendProfile: "deepseek", model: "deepseek-v4-pro" },
    );
  });

  it("keeps everything after the FIRST slash as the model", () => {
    assert.deepEqual(
      splitProviderModel("deepseek/foo/bar", configured),
      { backendProfile: "deepseek", model: "foo/bar" },
    );
  });

  it("a bare model id stays plain", () => {
    assert.deepEqual(splitProviderModel("opus", configured), { model: "opus" });
  });

  it("an unconfigured prefix stays plain (no false split on provider-routed slash ids)", () => {
    assert.deepEqual(
      splitProviderModel("anthropic/claude-opus-4", configured),
      { model: "anthropic/claude-opus-4" },
    );
  });

  it("empty prefix or empty suffix stays plain", () => {
    assert.deepEqual(splitProviderModel("/x", configured), { model: "/x" });
    assert.deepEqual(splitProviderModel("deepseek/", configured), { model: "deepseek/" });
  });
});

describe("resolveDefinitionName", () => {
  it("omitted from → general-purpose default", () => {
    assert.equal(resolveDefinitionName(undefined, undefined), DEFAULT_WORKER_DEFINITION);
  });

  it("empty or whitespace-only from → default", () => {
    assert.equal(resolveDefinitionName("", undefined), DEFAULT_WORKER_DEFINITION);
    assert.equal(resolveDefinitionName("   ", undefined), DEFAULT_WORKER_DEFINITION);
  });

  it("explicit from wins and is trimmed", () => {
    assert.equal(resolveDefinitionName("perf-profiler", undefined), "perf-profiler");
    assert.equal(resolveDefinitionName("  perf-profiler  ", undefined), "perf-profiler");
  });

  it("legacy role:git maps to git when from is empty", () => {
    assert.equal(resolveDefinitionName(undefined, "git"), "git");
    assert.equal(resolveDefinitionName("", "git"), "git");
  });

  it("explicit from beats role:git", () => {
    assert.equal(resolveDefinitionName("reviewer", "git"), "reviewer");
  });
});

describe("resolveWorkerDefinitionByName (handler turns null into a hard error)", () => {
  const records: WorkerDefinitionRecord[] = [
    { name: "general-purpose", description: "", whenToUse: "", body: "", source: "builtin" },
    { name: "git", description: "", whenToUse: "", body: "", source: "builtin" },
  ];

  it("resolves the default built-in", () => {
    assert.equal(resolveWorkerDefinitionByName(DEFAULT_WORKER_DEFINITION, records)?.name, DEFAULT_WORKER_DEFINITION);
  });

  it("unknown name → null (the spawn handler rejects this, never degrades)", () => {
    assert.equal(resolveWorkerDefinitionByName("perf-profiler", records), null);
  });
});
