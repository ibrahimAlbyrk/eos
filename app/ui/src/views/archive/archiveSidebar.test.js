import { describe, it, expect } from "vitest";
// Raw-source assertions (the archiveToggle.test.js precedent): the archive
// tree must mirror the live tree's expand interaction, and that contract is
// wiring — same collapse store, same chevron affordance, same CSS hooks.
import sidebarSrc from "./ArchiveSidebar.jsx?raw";
import agentsTreeSrc from "../code/sidebar/AgentsTree.jsx?raw";

describe("archived orchestrators expand like the live tree", () => {
  it("renders the nested archivedTree, not a flat roots list", () => {
    expect(sidebarSrc).toContain("archivedTree(rows)");
    expect(sidebarSrc).toContain("node.children.map");
  });

  it("uses the live tree's collapse mechanism (shared ui store)", () => {
    for (const src of [sidebarSrc, agentsTreeSrc]) {
      expect(src).toContain("ui.collapsedNodes.has(node.id)");
      expect(src).toContain("ui.toggleNodeCollapsed(node.id)");
    }
  });

  it("shows the chevron affordance on parents and the spacer on leaves, like the live tree", () => {
    for (const src of [sidebarSrc, agentsTreeSrc]) {
      expect(src).toMatch(/hasChildren \? \(\s*<button\s+className="tree-chev"/);
      expect(src).toContain('className="tree-chev-spacer"');
    }
  });

  it("reuses the live tree's CSS hooks so collapse hides children without new styles", () => {
    for (const src of [sidebarSrc, agentsTreeSrc]) {
      expect(src).toContain("tree-node");
      expect(src).toContain("collapsed");
      expect(src).toContain('"tree-children"');
    }
  });

  it("child rows are selectable but only roots open the archive context menu", () => {
    expect(sidebarSrc).toContain("selectArchived(node.id)");
    expect(sidebarSrc).toMatch(/if \(isRoot\) ui\.openPop\("archive-ctx"/);
  });
});
