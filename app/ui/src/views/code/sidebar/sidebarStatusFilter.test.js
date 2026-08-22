import { describe, it, expect } from "vitest";
// Raw-source wiring assertions (the archiveToggle.test.js precedent it replaces):
// archive is no longer a standalone toggle button — it's the "Archived" option of
// the sidebar Status filter. The sidebar list is chosen by the persisted status
// pref; the main-area archive view stays gated on archiveMode (now driven by the
// status filter + selection instead of the removed button).
import codeSidebarSrc from "./CodeSidebar.jsx?raw";
import sidebarHeadSrc from "./SidebarHead.jsx?raw";
import prefsMenuSrc from "./SidebarPrefsMenu.jsx?raw";
import codeViewSrc from "../CodeView.jsx?raw";
import registrySrc from "../../registry.js?raw";
import tabsSrc from "../../tabs.js?raw";

describe("archive is a status filter, not a standalone toggle", () => {
  it("registry and tabs carry no Archive view entries", () => {
    for (const src of [registrySrc, tabsSrc]) {
      expect(src.toLowerCase()).not.toContain("archive");
    }
  });

  it("the standalone ArchiveToggle button is gone from the header", () => {
    expect(sidebarHeadSrc).not.toContain("ArchiveToggle");
    expect(sidebarHeadSrc).toContain('data-popover-trigger="sidebar-prefs"');
  });

  it("feeds ONE unified list, filtered by the persisted status pref", () => {
    expect(codeSidebarSrc).toContain("useSidebarPrefs");
    expect(codeSidebarSrc).toContain('status !== "archived"');
    expect(codeSidebarSrc).toContain('status !== "active"');
    // Live + archived are normalized into one tagged root list through a single
    // AgentsTree — no separate ArchiveSidebar section anymore.
    expect(codeSidebarSrc).toContain("buildAgentTree");
    expect(codeSidebarSrc).toContain("archivedTree");
    expect(codeSidebarSrc).toContain("__archived");
    expect(codeSidebarSrc).toContain("<AgentsTree");
    expect(codeSidebarSrc).not.toContain("<ArchiveSidebar");
    expect(codeSidebarSrc).not.toContain("ArchiveToggle");
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
