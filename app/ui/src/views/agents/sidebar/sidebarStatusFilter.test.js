import { describe, it, expect } from "vitest";
// Raw-source wiring assertions (the archiveToggle.test.js precedent it replaces):
// archive is no longer a standalone toggle button — it's the "Archived" option of
// the sidebar Status filter. The sidebar list is chosen by the persisted status
// pref; the main-area archive view stays gated on archiveMode (now driven by the
// status filter + selection instead of the removed button).
import agentsSidebarSrc from "./AgentsSidebar.jsx?raw";
import sidebarHeadSrc from "./SidebarHead.jsx?raw";
import prefsMenuSrc from "./SidebarPrefsMenu.jsx?raw";
import codeViewSrc from "../AgentsView.jsx?raw";
import registrySrc from "../../registry.js?raw";
import tabsSrc from "../../tabs.js?raw";

describe("archive is a status filter, not a standalone toggle", () => {
  it("registry and tabs carry no Archive view entries", () => {
    for (const src of [registrySrc, tabsSrc]) {
      expect(src.toLowerCase()).not.toContain("archive");
    }
  });

  it("the standalone ArchiveToggle button is gone; view-options filter lives on the Projects label", () => {
    expect(sidebarHeadSrc).not.toContain("ArchiveToggle");
    // The sliders/view-options trigger moved out of SidebarHead onto the
    // AgentsSidebar's Projects/Recent/Groups section label.
    expect(agentsSidebarSrc).toContain('data-popover-trigger="sidebar-prefs"');
  });

  it("feeds ONE unified list, filtered by the persisted status pref", () => {
    expect(agentsSidebarSrc).toContain("useSidebarPrefs");
    expect(agentsSidebarSrc).toContain('status !== "archived"');
    expect(agentsSidebarSrc).toContain('status !== "active"');
    // Live + archived are normalized into one tagged root list through a single
    // AgentsTree — no separate ArchiveSidebar section anymore.
    expect(agentsSidebarSrc).toContain("buildAgentTree");
    expect(agentsSidebarSrc).toContain("archivedTree");
    expect(agentsSidebarSrc).toContain("__archived");
    expect(agentsSidebarSrc).toContain("<AgentsTree");
    expect(agentsSidebarSrc).not.toContain("<ArchiveSidebar");
    expect(agentsSidebarSrc).not.toContain("ArchiveToggle");
  });

  it("the settings popover exposes group-by / sort-by / status and drives archive viewing", () => {
    for (const key of ["Group by", "Sort by", "Status"]) {
      expect(prefsMenuSrc).toContain(key);
    }
    expect(prefsMenuSrc).toContain("setArchiveViewing");
  });

  it("the main area still swaps to the archive panel on archiveMode", () => {
    expect(codeViewSrc).toContain("archiveMode ? (");
    expect(codeViewSrc).toContain("<ArchiveView live={live} />");
  });
});
