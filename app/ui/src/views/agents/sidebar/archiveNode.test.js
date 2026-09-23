import { describe, it, expect } from "vitest";
// Raw-source assertions (the archiveToggle.test.js precedent): archived rows now
// render inline in the unified list via ArchiveNode, sharing the live tree's
// expand interaction. Rendering isn't feasible in the node test env, so the
// contract is asserted at the source level.
import archiveNodeSrc from "./ArchiveNode.jsx?raw";
import agentsTreeSrc from "./AgentsTree.jsx?raw";

describe("archived rows mirror the live tree's expand interaction", () => {
  it("use the shared collapse store (ui.collapsedNodes / toggleNodeCollapsed)", () => {
    for (const src of [archiveNodeSrc, agentsTreeSrc]) {
      expect(src).toContain("ui.collapsedNodes.has(node.id)");
    }
    expect(archiveNodeSrc).toContain("ui.toggleNodeCollapsed(node.id)");
  });

  it("show the chevron on parents and the spacer on leaves, like the live tree", () => {
    for (const src of [archiveNodeSrc, agentsTreeSrc]) {
      expect(src).toMatch(/hasChildren \? \(\s*<button\s+className="tree-chev"/);
      expect(src).toContain('className="tree-chev-spacer"');
    }
  });

  it("reuse the live tree's CSS hooks so collapse hides children without new styles", () => {
    for (const src of [archiveNodeSrc, agentsTreeSrc]) {
      expect(src).toContain("tree-node");
      expect(src).toContain('"tree-children"');
    }
  });

  it("child rows are selectable but only roots open the archive context menu", () => {
    expect(archiveNodeSrc).toContain("selectArchived(node.id)");
    expect(archiveNodeSrc).toMatch(/if \(isRoot\) ui\.openPop\("archive-ctx"/);
  });

  it("render the archive-tray icon + dimmed styling, not a trash can", () => {
    expect(archiveNodeSrc).toContain("ag-archive-icon");
    expect(archiveNodeSrc).toContain("agents-row--archived");
    expect(archiveNodeSrc).not.toContain("TrashIcon");
  });
});

describe("the unified list dispatches per row kind", () => {
  it("AgentsTree renders ArchiveNode for archived roots and TreeNode otherwise", () => {
    expect(agentsTreeSrc).toContain("ArchiveNode");
    expect(agentsTreeSrc).toContain("n.__archived");
  });
});
