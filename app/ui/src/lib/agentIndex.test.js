import { describe, it, expect, beforeEach } from "vitest";
import { updateAgentIndex, sessionRootOf, GLOBAL_SESSION, _resetAgentIndex } from "./agentIndex.js";

beforeEach(() => _resetAgentIndex());

describe("agentIndex", () => {
  it("resolves an agent to its parent-chain root (the session key)", () => {
    updateAgentIndex([
      { id: "o-1", parent_id: null },
      { id: "w-1", parent_id: "o-1" },
      { id: "w-2", parent_id: "w-1" },
    ]);
    expect(sessionRootOf("o-1")).toBe("o-1");
    expect(sessionRootOf("w-1")).toBe("o-1");
    expect(sessionRootOf("w-2")).toBe("o-1");
  });

  it("no agent resolves to the global session; an unknown id to itself", () => {
    expect(sessionRootOf(null)).toBe(GLOBAL_SESSION);
    expect(sessionRootOf(undefined)).toBe(GLOBAL_SESSION);
    expect(sessionRootOf("ghost")).toBe("ghost");
  });

  it("stops at the last RESOLVABLE node when a parent left the snapshot (breadcrumb rule)", () => {
    updateAgentIndex([{ id: "w-1", parent_id: "gone" }]);
    expect(sessionRootOf("w-1")).toBe("w-1");
  });

  it("is cycle-guarded", () => {
    updateAgentIndex([
      { id: "a", parent_id: "b" },
      { id: "b", parent_id: "a" },
    ]);
    expect(["a", "b"]).toContain(sessionRootOf("a"));
  });

  it("a snapshot refresh replaces the index; junk input is ignored", () => {
    updateAgentIndex([{ id: "w-1", parent_id: "o-1" }, { id: "o-1", parent_id: null }]);
    expect(sessionRootOf("w-1")).toBe("o-1");
    updateAgentIndex("nope"); // ignored
    expect(sessionRootOf("w-1")).toBe("o-1");
    updateAgentIndex([]); // real empty snapshot clears it
    expect(sessionRootOf("w-1")).toBe("w-1");
  });
});
