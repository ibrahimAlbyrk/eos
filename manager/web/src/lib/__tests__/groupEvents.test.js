import { describe, it, expect } from "vitest";
import { groupEvents, turnBlocks } from "../groupEvents.js";

const e = (overrides) => ({ id: "x", ts: "00:00:00", agent: "a", ...overrides });

describe("groupEvents", () => {
  it("emits a single user turn per user event", () => {
    const turns = groupEvents([
      e({ type: "user", agent: "user", body: "hi" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ kind: "user", agent: "user" });
  });

  it("emits a system turn per system/spawn/complete event", () => {
    const turns = groupEvents([
      e({ type: "system", agent: "w-1", body: "x" }),
      e({ type: "spawn", agent: "w-2" }),
      e({ type: "complete", agent: "w-3", body: "done" }),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns.every(t => t.kind === "system")).toBe(true);
  });

  it("groups consecutive agent events by agent into one turn", () => {
    const turns = groupEvents([
      e({ type: "thought", agent: "w-1", body: "thinking" }),
      e({ type: "tool", agent: "w-1", tool: "Read", args: "{}" }),
      e({ type: "result", agent: "w-1", body: "ok" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].kind).toBe("agent");
    expect(turns[0].events).toHaveLength(3);
  });

  it("splits when agent changes", () => {
    const turns = groupEvents([
      e({ type: "thought", agent: "w-1", body: "a" }),
      e({ type: "thought", agent: "w-2", body: "b" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].agent).toBe("w-1");
    expect(turns[1].agent).toBe("w-2");
  });

  it("skips policy events", () => {
    const turns = groupEvents([
      e({ type: "policy", agent: "w-1", body: "denied" }),
    ]);
    expect(turns).toHaveLength(0);
  });
});

describe("turnBlocks", () => {
  it("pairs tool with matching toolUseId result", () => {
    const turn = {
      kind: "agent",
      agent: "w-1",
      events: [
        e({ type: "tool", toolUseId: "T1", tool: "Read", args: "{}" }),
        e({ type: "result", toolUseId: "T1", body: "file contents" }),
      ],
    };
    const blocks = turnBlocks(turn);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("toolpair");
    expect(blocks[0].tool.toolUseId).toBe("T1");
    expect(blocks[0].result.body).toBe("file contents");
  });

  it("does not cross-match when ids differ — fallback walks forward", () => {
    // Tool A then unrelated result B — positional fallback still pairs them
    // since the second pass ignores id mismatch.
    const turn = {
      kind: "agent",
      agent: "w-1",
      events: [
        e({ type: "tool", toolUseId: "T1", tool: "Read" }),
        e({ type: "result", toolUseId: "T2", body: "x" }),
      ],
    };
    const blocks = turnBlocks(turn);
    // Pass 1 doesn't match (id mismatch), pass 2 grabs the next unconsumed result.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("toolpair");
  });

  it("emits an unpaired tool with kind 'tool' when no result exists", () => {
    const turn = {
      kind: "agent",
      agent: "w-1",
      events: [
        e({ type: "tool", toolUseId: "T1", tool: "Bash" }),
      ],
    };
    const blocks = turnBlocks(turn);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("tool");
  });

  it("emits thought blocks in original order", () => {
    const turn = {
      kind: "agent",
      agent: "w-1",
      events: [
        e({ type: "thought", body: "first" }),
        e({ type: "tool", toolUseId: "T1", tool: "Read" }),
        e({ type: "result", toolUseId: "T1", body: "ok" }),
        e({ type: "thought", body: "second" }),
      ],
    };
    const blocks = turnBlocks(turn);
    expect(blocks.map(b => b.kind)).toEqual(["thought", "toolpair", "thought"]);
  });

  it("emits orphan result when no tool precedes it", () => {
    const turn = {
      kind: "agent",
      agent: "w-1",
      events: [
        e({ type: "result", body: "orphan" }),
      ],
    };
    const blocks = turnBlocks(turn);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("result");
  });
});
