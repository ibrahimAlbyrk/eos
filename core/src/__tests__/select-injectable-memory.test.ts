import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectInjectableMemory } from "../services/select-injectable-memory.ts";
import type { MemoryDoc, MemorySnapshot } from "../ports/MemoryProvider.ts";

const doc = (sourceId: string, nativeFor: string[]): MemoryDoc => ({
  sourceId, sourceLabel: sourceId, nativeFor, path: `/x/${sourceId}`, level: "project", content: "x",
});

describe("selectInjectableMemory — drop sources the backend loads natively", () => {
  it("filters out docs whose source is native for the kind (claude-cli loads CLAUDE.md)", () => {
    const snap: MemorySnapshot = { docs: [doc("claude", ["claude-cli"]), doc("agents", [])] };
    assert.deepEqual(selectInjectableMemory(snap, "claude-cli").docs.map((d) => d.sourceId), ["agents"]);
  });

  it("keeps everything for a kind that loads nothing natively (claude-sdk)", () => {
    const snap: MemorySnapshot = { docs: [doc("claude", ["claude-cli"]), doc("agents", [])] };
    assert.deepEqual(selectInjectableMemory(snap, "claude-sdk").docs.map((d) => d.sourceId), ["claude", "agents"]);
  });
});
