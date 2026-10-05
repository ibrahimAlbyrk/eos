import { describe, it, expect } from "vitest";
import { EMPTY_TABS, openTab, openNewTab, closeTab, activateTab, tabType, fileTabId, filePathOf, replaceTab, newTabId, pageTabId, pageIdOf, mountedTabs } from "./panelTabs.js";

describe("panelTabs", () => {
  it("opens tabs in order and activates the opened one", () => {
    let s = openTab(EMPTY_TABS, "review");
    expect(s).toEqual({ openTabs: ["review"], activeTab: "review", tabHistory: ["review"] });
    s = openTab(s, "files");
    expect(s).toEqual({ openTabs: ["review", "files"], activeTab: "files", tabHistory: ["review", "files"] });
  });

  it("re-opening an open tab only re-activates it (no duplicate)", () => {
    const s = openTab({ openTabs: ["review", "files"], activeTab: "files" }, "review");
    expect(s.openTabs).toEqual(["review", "files"]);
    expect(s.activeTab).toBe("review");
  });

  it("closing the active tab activates the right neighbor", () => {
    const s = closeTab({ openTabs: ["review", "files", "terminal"], activeTab: "files" }, "files");
    expect(s).toEqual({ openTabs: ["review", "terminal"], activeTab: "terminal", tabHistory: [] });
  });

  it("closing the active tab goes back to the previously active one", () => {
    let s = openTab(EMPTY_TABS, "review");
    s = openTab(s, "files");
    s = openTab(s, "terminal");
    s = activateTab(s, "review");
    s = activateTab(s, "files");
    s = closeTab(s, "files");
    expect(s.activeTab).toBe("review");
    s = closeTab(s, "review");
    expect(s.activeTab).toBe("terminal");
  });

  it("activateTab ignores absent or already-active tabs", () => {
    const s0 = { openTabs: ["review"], activeTab: "review", tabHistory: ["review"] };
    expect(activateTab(s0, "review")).toBe(s0);
    expect(activateTab(s0, "files")).toBe(s0);
  });

  it("closing the last (active) tab activates the new last", () => {
    const s = closeTab({ openTabs: ["review", "files"], activeTab: "files" }, "files");
    expect(s).toEqual({ openTabs: ["review"], activeTab: "review", tabHistory: [] });
  });

  it("closing the only tab leaves an empty panel", () => {
    const s = closeTab({ openTabs: ["review"], activeTab: "review" }, "review");
    expect(s).toEqual({ openTabs: [], activeTab: null, tabHistory: [] });
  });

  it("closing a non-active tab keeps the active one", () => {
    const s = closeTab({ openTabs: ["review", "files", "terminal"], activeTab: "terminal" }, "files");
    expect(s.openTabs).toEqual(["review", "terminal"]);
    expect(s.activeTab).toBe("terminal");
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
    expect(s).toMatchObject({ openTabs: ["terminal:1"], activeTab: "terminal:1" });
    s = openNewTab(s, "terminal");
    expect(s).toMatchObject({ openTabs: ["terminal:1", "terminal:2"], activeTab: "terminal:2" });
  });

  it("openNewTab fills the lowest free terminal number after a close", () => {
    const s = openNewTab({ openTabs: ["terminal:2"], activeTab: "terminal:2" }, "terminal");
    expect(s.openTabs).toEqual(["terminal:2", "terminal:1"]);
    expect(s.activeTab).toBe("terminal:1");
  });

  it("openNewTab treats non-multi types as singletons (re-activates)", () => {
    const s = openNewTab({ openTabs: ["files"], activeTab: "files" }, "files");
    expect(s).toMatchObject({ openTabs: ["files"], activeTab: "files" });
  });

  it("each opened file is its own tab, keyed by path", () => {
    let s = openTab(EMPTY_TABS, "files");
    s = openTab(s, fileTabId("/a/x.md"));
    s = openTab(s, fileTabId("/b/y.png"));
    s = openTab(s, fileTabId("/a/x.md"));
    expect(s).toMatchObject({ openTabs: ["files", "file:/a/x.md", "file:/b/y.png"], activeTab: "file:/a/x.md" });
    expect(tabType("file:/a/x.md")).toBe("file");
    expect(filePathOf("file:/a/b:c.md")).toBe("/a/b:c.md");
    expect(filePathOf("files")).toBe(null);
    expect(filePathOf(null)).toBe(null);
  });
});

describe("panelTabs replace (new-tab launcher)", () => {
  it("each + opens a fresh launcher instance", () => {
    let s = openNewTab(EMPTY_TABS, "newtab");
    s = openNewTab(s, "newtab");
    expect(s.openTabs).toEqual(["newtab:1", "newtab:2"]);
  });

  it("a launcher becomes what it opened, in the same slot", () => {
    let s = openTab(EMPTY_TABS, "review");
    s = openNewTab(s, "newtab");
    s = openTab(s, "files");
    s = activateTab(s, "newtab:1");
    s = replaceTab(s, "newtab:1", newTabId(s, "terminal"));
    expect(s.openTabs).toEqual(["review", "terminal:1", "files"]);
    expect(s.activeTab).toBe("terminal:1");
    expect(s.tabHistory).not.toContain("newtab:1");
  });

  it("opening an already-open tab from a launcher closes the launcher and activates it", () => {
    let s = openTab(EMPTY_TABS, "review");
    s = openNewTab(s, "newtab");
    s = replaceTab(s, "newtab:1", "review");
    expect(s.openTabs).toEqual(["review"]);
    expect(s.activeTab).toBe("review");
  });

  it("without an open launcher it is a plain open", () => {
    const s = replaceTab(EMPTY_TABS, "newtab:9", pageTabId("pg-1"));
    expect(s.openTabs).toEqual(["page:pg-1"]);
    expect(pageIdOf(s.activeTab)).toBe("pg-1");
    expect(pageIdOf("files")).toBe(null);
  });
});

describe("panelTabs mountedTabs (tabs kept alive)", () => {
  it("keeps every tab shown once mounted, in tab order, while another is shown", () => {
    expect(mountedTabs(new Set(["files", "review"]), ["review", "terminal:1", "files"], "review", true)).toEqual(["review", "files"]);
  });

  it("mounts the active tab only while the panel is on screen", () => {
    expect(mountedTabs(new Set(), ["review", "files"], "files", true)).toEqual(["files"]);
    expect(mountedTabs(new Set(), ["review", "files"], "files", false)).toEqual([]);
    expect(mountedTabs(new Set(["files"]), ["review", "files"], "files", false)).toEqual(["files"]);
  });

  it("drops a closed tab even if it was shown", () => {
    expect(mountedTabs(new Set(["review", "files"]), ["files"], "files", true)).toEqual(["files"]);
  });
});
