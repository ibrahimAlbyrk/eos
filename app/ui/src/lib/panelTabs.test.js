import { describe, it, expect } from "vitest";
import { EMPTY_TABS, openTab, openNewTab, closeTab, tabType, fileTabId, filePathOf } from "./panelTabs.js";

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

describe("panelTabs instances", () => {
  it("tabType strips the instance suffix", () => {
    expect(tabType("terminal")).toBe("terminal");
    expect(tabType("terminal:2")).toBe("terminal");
    expect(tabType("files")).toBe("files");
  });

  it("openNewTab adds a fresh terminal instance each time", () => {
    let s = openNewTab(EMPTY_TABS, "terminal");
    expect(s).toEqual({ openTabs: ["terminal:1"], activeTab: "terminal:1" });
    s = openNewTab(s, "terminal");
    expect(s).toEqual({ openTabs: ["terminal:1", "terminal:2"], activeTab: "terminal:2" });
  });

  it("openNewTab fills the lowest free terminal number after a close", () => {
    const s = openNewTab({ openTabs: ["terminal:2"], activeTab: "terminal:2" }, "terminal");
    expect(s.openTabs).toEqual(["terminal:2", "terminal:1"]);
    expect(s.activeTab).toBe("terminal:1");
  });

  it("openNewTab treats non-multi types as singletons (re-activates)", () => {
    const s = openNewTab({ openTabs: ["files"], activeTab: "files" }, "files");
    expect(s).toEqual({ openTabs: ["files"], activeTab: "files" });
  });

  it("each opened file is its own tab, keyed by path", () => {
    let s = openTab(EMPTY_TABS, "files");
    s = openTab(s, fileTabId("/a/x.md"));
    s = openTab(s, fileTabId("/b/y.png"));
    s = openTab(s, fileTabId("/a/x.md"));
    expect(s).toEqual({ openTabs: ["files", "file:/a/x.md", "file:/b/y.png"], activeTab: "file:/a/x.md" });
    expect(tabType("file:/a/x.md")).toBe("file");
    expect(filePathOf("file:/a/b:c.md")).toBe("/a/b:c.md");
    expect(filePathOf("files")).toBe(null);
    expect(filePathOf(null)).toBe(null);
  });
});
