import { describe, it, expect } from "vitest";
import { openPanel, closePanel, popPanel, topPanel, updatePanelData } from "./panelStack.js";

describe("openPanel", () => {
  it("pushes a new entry on top", () => {
    const s = openPanel([], "agent", { toolUseId: "t1" });
    expect(s).toEqual([{ type: "agent", data: { toolUseId: "t1" } }]);
  });

  it("stacks a different type on top of the current one", () => {
    let s = openPanel([], "agent", { toolUseId: "t1" });
    s = openPanel(s, "file", { path: "/a" });
    expect(s.map((p) => p.type)).toEqual(["agent", "file"]);
  });

  it("hoists an existing entry of the same type instead of duplicating", () => {
    let s = openPanel([], "diff", { workerId: "w1" });
    s = openPanel(s, "file", { path: "/a" });
    s = openPanel(s, "diff", { workerId: "w2" });
    expect(s.map((p) => p.type)).toEqual(["file", "diff"]);
    expect(topPanel(s).data).toEqual({ workerId: "w2" });
  });

  it("replaces the top when re-opening the same type", () => {
    let s = openPanel([], "file", { path: "/a" });
    s = openPanel(s, "file", { path: "/b" });
    expect(s).toEqual([{ type: "file", data: { path: "/b" } }]);
  });

  it("does not mutate the input", () => {
    const s = [{ type: "agent", data: {} }];
    openPanel(s, "file", { path: "/a" });
    expect(s).toEqual([{ type: "agent", data: {} }]);
  });
});

describe("closePanel", () => {
  it("removes the entry of that type, revealing the one underneath", () => {
    let s = openPanel([], "agent", { toolUseId: "t1" });
    s = openPanel(s, "file", { path: "/a" });
    s = closePanel(s, "file");
    expect(topPanel(s)).toEqual({ type: "agent", data: { toolUseId: "t1" } });
  });

  it("removes a buried entry (toggle button while another panel is on top)", () => {
    let s = openPanel([], "diff", { workerId: "w1" });
    s = openPanel(s, "file", { path: "/a" });
    s = closePanel(s, "diff");
    expect(s.map((p) => p.type)).toEqual(["file"]);
  });

  it("returns the same reference when the type is absent", () => {
    const s = [{ type: "file", data: { path: "/a" } }];
    expect(closePanel(s, "agent")).toBe(s);
  });
});

describe("popPanel", () => {
  it("removes the top entry", () => {
    let s = openPanel([], "agent", {});
    s = openPanel(s, "file", { path: "/a" });
    expect(popPanel(s).map((p) => p.type)).toEqual(["agent"]);
  });

  it("returns the same reference when empty", () => {
    const s = [];
    expect(popPanel(s)).toBe(s);
  });
});

describe("topPanel", () => {
  it("returns null for an empty stack", () => {
    expect(topPanel([])).toBeNull();
  });
});

describe("updatePanelData", () => {
  it("updates a buried entry in place", () => {
    let s = openPanel([], "agent", { toolUseId: "t1", status: "running" });
    s = openPanel(s, "file", { path: "/a" });
    const next = updatePanelData(s, "agent", (d) => ({ ...d, status: "completed" }));
    expect(next.map((p) => p.type)).toEqual(["agent", "file"]);
    expect(next[0].data.status).toBe("completed");
  });

  it("returns the same reference when the type is absent", () => {
    const s = [{ type: "file", data: { path: "/a" } }];
    expect(updatePanelData(s, "agent", (d) => ({ ...d }))).toBe(s);
  });

  it("returns the same reference when the updater keeps the data", () => {
    const s = openPanel([], "agent", { toolUseId: "t1" });
    expect(updatePanelData(s, "agent", (d) => d)).toBe(s);
  });
});

// The reported bug end-to-end: read-tool file click inside the agent panel.
describe("agent panel → file viewer → close", () => {
  it("returns to the agent panel after closing the file viewer", () => {
    let s = openPanel([], "agent", { toolUseId: "t1" });
    s = openPanel(s, "file", { path: "/read/file.ts" });
    expect(topPanel(s).type).toBe("file");
    s = closePanel(s, "file");
    expect(topPanel(s).type).toBe("agent");
    s = popPanel(s);
    expect(topPanel(s)).toBeNull();
  });
});
