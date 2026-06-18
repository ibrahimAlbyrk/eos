import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMemorySources } from "../domain/memory-sources.ts";

describe("resolveMemorySources — config map → ordered, defaulted list", () => {
  it("folds the key in as id and applies field defaults", () => {
    const [s] = resolveMemorySources({ claude: { label: "CLAUDE.md", projectFilenames: ["CLAUDE.md"] } });
    assert.deepEqual(s, {
      id: "claude", label: "CLAUDE.md", userPaths: [], projectFilenames: ["CLAUDE.md"], priority: 0, assumeNativeFor: [],
    });
  });

  it("defaults the label to the id when absent", () => {
    assert.equal(resolveMemorySources({ agents: {} })[0].label, "agents");
  });

  it("drops disabled sources", () => {
    const out = resolveMemorySources({ claude: { enabled: false }, agents: { enabled: true } });
    assert.deepEqual(out.map((s) => s.id), ["agents"]);
  });

  it("sorts by priority then id", () => {
    const out = resolveMemorySources({ b: { priority: 10 }, a: { priority: 10 }, z: { priority: 0 } });
    assert.deepEqual(out.map((s) => s.id), ["z", "a", "b"]);
  });
});
