import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { softFdLimit } from "../util/fd-stats.ts";

describe("fd-stats", () => {
  it("caps the macOS limit at the posix_spawn ceiling, not the rlimit", { skip: process.platform !== "darwin" }, () => {
    const limit = softFdLimit();
    assert.ok(limit != null && limit <= 10240, `expected ≤ 10240, got ${limit}`);
  });
});
