import { describe, it, expect } from "vitest";
import { EMPTY_TABS, openTab, closeTab } from "./panelTabs.js";

describe("panelTabs", () => {
  it("opens tabs in order and activates the opened one", () => {
    let s = openTab(EMPTY_TABS, "review");
    expect(s).toEqual({ openTabs: ["review"], activeTab: "review" });
    s = openTab(s, "files");
    expect(s).toEqual({ openTabs: ["review", "files"], activeTab: "files" });
  });

  it("re-opening an open tab only re-activates it (no duplicate)", () => {
    const s = openTab({ openTabs: ["review", "files"], activeTab: "files" }, "review");
    expect(s).toEqual({ openTabs: ["review", "files"], activeTab: "review" });
  });

  it("closing the active tab activates the right neighbor", () => {
    const s = closeTab({ openTabs: ["review", "files", "terminal"], activeTab: "files" }, "files");
    expect(s).toEqual({ openTabs: ["review", "terminal"], activeTab: "terminal" });
  });

  it("closing the last (active) tab activates the new last", () => {
    const s = closeTab({ openTabs: ["review", "files"], activeTab: "files" }, "files");
    expect(s).toEqual({ openTabs: ["review"], activeTab: "review" });
  });

  it("closing the only tab leaves an empty panel", () => {
    const s = closeTab({ openTabs: ["review"], activeTab: "review" }, "review");
    expect(s).toEqual({ openTabs: [], activeTab: null });
  });

  it("closing a non-active tab keeps the active one", () => {
    const s = closeTab({ openTabs: ["review", "files", "terminal"], activeTab: "terminal" }, "files");
    expect(s).toEqual({ openTabs: ["review", "terminal"], activeTab: "terminal" });
  });

  it("closing an absent tab is a no-op (same reference)", () => {
    const s0 = { openTabs: ["review"], activeTab: "review" };
    expect(closeTab(s0, "files")).toBe(s0);
  });
});
