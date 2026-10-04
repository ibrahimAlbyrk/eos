import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomOrchestratorName } from "../names.ts";

describe("randomOrchestratorName", () => {
  it("is '<adjective>-<3 digits>' with no role suffix", () => {
    for (let i = 0; i < 50; i++) assert.match(randomOrchestratorName(), /^[a-z]+-\d{3}$/);
  });
});
