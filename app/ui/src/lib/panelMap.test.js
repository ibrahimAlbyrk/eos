import { describe, it, expect } from "vitest";
import { topTypeIn, dataIn, openIn, closeIn, popIn, updateDataIn, clearPane, retainPanes } from "./panelMap.js";

describe("per-pane keying", () => {
  it("opens a panel under its own pane, leaving other panes untouched", () => {
    let m = {};
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "diff", { workerId: "w1" });
    expect(topTypeIn(m, "A")).toBe("file");
    expect(topTypeIn(m, "B")).toBe("diff");
    expect(dataIn(m, "A", "file")).toEqual({ path: "/a" });
    expect(dataIn(m, "B", "diff")).toEqual({ workerId: "w1" });
  });

  it("allows one panel per pane simultaneously", () => {
    let m = {};
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "file", { path: "/b" });
    expect(dataIn(m, "A", "file")).toEqual({ path: "/a" });
    expect(dataIn(m, "B", "file")).toEqual({ path: "/b" });
  });

  it("reuses panelStack semantics inside a pane (stack, hoist, pop)", () => {
    let m = {};
    m = openIn(m, "A", "agent", { toolUseId: "t1" });
    m = openIn(m, "A", "file", { path: "/a" });
    expect(topTypeIn(m, "A")).toBe("file");
    m = closeIn(m, "A", "file");
    expect(topTypeIn(m, "A")).toBe("agent");
    m = popIn(m, "A");
    expect(topTypeIn(m, "A")).toBeNull();
  });

  it("treats a null/absent pane as empty and is a safe no-op", () => {
    const m = openIn({}, "A", "file", { path: "/a" });
    expect(topTypeIn(m, null)).toBeNull();
    expect(dataIn(m, "Z", "file")).toBeNull();
    expect(openIn(m, null, "file", {})).toBe(m);
    expect(closeIn(m, "Z", "file")).toBe(m);
    expect(popIn(m, "Z")).toBe(m);
  });

  it("returns the same map ref when an operation changes nothing", () => {
    const m = openIn({}, "A", "file", { path: "/a" });
    expect(closeIn(m, "A", "diff")).toBe(m);
    expect(updateDataIn(m, "A", "diff", (d) => d)).toBe(m);
  });

  it("updates a buried entry in place without touching other panes", () => {
    let m = openIn({}, "A", "agent", { toolUseId: "t1", status: "running" });
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "file", { path: "/b" });
    const next = updateDataIn(m, "A", "agent", (d) => ({ ...d, status: "done" }));
    expect(dataIn(next, "A", "agent").status).toBe("done");
    expect(next.B).toBe(m.B);
  });
});

describe("clear-on-rebuild", () => {
  it("clearPane drops a closed pane's panel only", () => {
    let m = {};
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "diff", { workerId: "w1" });
    const next = clearPane(m, "A");
    expect("A" in next).toBe(false);
    expect(topTypeIn(next, "B")).toBe("diff");
  });

  it("clearPane is a same-ref no-op when the pane has no panel", () => {
    const m = openIn({}, "A", "file", { path: "/a" });
    expect(clearPane(m, "Z")).toBe(m);
  });

  it("retainPanes drops panels whose paneId is no longer live (preset reapply)", () => {
    let m = {};
    m = openIn(m, "old1", "file", { path: "/a" });
    m = openIn(m, "old2", "diff", { workerId: "w1" });
    // fillAgents minted fresh ids — none of the old leaf ids survive.
    const next = retainPanes(m, new Set(["new1", "new2"]));
    expect(Object.keys(next)).toEqual([]);
  });

  it("retainPanes keeps survivors and drops only the removed pane", () => {
    let m = {};
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "diff", { workerId: "w1" });
    const next = retainPanes(m, new Set(["A"]));
    expect(Object.keys(next)).toEqual(["A"]);
    expect(next.A).toBe(m.A);
  });

  it("retainPanes is a same-ref no-op when every pane is still live", () => {
    let m = {};
    m = openIn(m, "A", "file", { path: "/a" });
    m = openIn(m, "B", "diff", { workerId: "w1" });
    expect(retainPanes(m, new Set(["A", "B"]))).toBe(m);
  });
});
