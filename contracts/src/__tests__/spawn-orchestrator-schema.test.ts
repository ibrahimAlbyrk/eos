import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpawnOrchestratorRequestSchema } from "../http.ts";

describe("SpawnOrchestratorRequestSchema — cwd vs No folder", () => {
  it("accepts a folder", () => {
    assert.equal(SpawnOrchestratorRequestSchema.safeParse({ cwd: "/repo" }).success, true);
  });

  it("accepts No folder (scratch)", () => {
    assert.equal(SpawnOrchestratorRequestSchema.safeParse({ scratch: true }).success, true);
  });

  it("rejects neither and both", () => {
    assert.equal(SpawnOrchestratorRequestSchema.safeParse({}).success, false);
    assert.equal(SpawnOrchestratorRequestSchema.safeParse({ cwd: "/repo", scratch: true }).success, false);
  });
});
