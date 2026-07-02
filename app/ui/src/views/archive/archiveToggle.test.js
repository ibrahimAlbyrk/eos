import { describe, it, expect } from "vitest";
// Raw-source assertions (the archiveFunnel.test.js precedent): the toggle is a
// wiring contract — archive is a sidebar mode inside the Code view, not a
// routed tab. Rendering components isn't feasible in the node test env, so the
// wiring is asserted at the source level.
import codeSidebarSrc from "../code/sidebar/CodeSidebar.jsx?raw";
import codeViewSrc from "../code/CodeView.jsx?raw";
import toggleSrc from "./ArchiveToggle.jsx?raw";
import registrySrc from "../registry.js?raw";
import tabsSrc from "../tabs.js?raw";
import archiveViewSrc from "./ArchiveView.jsx?raw";

describe("archive is a sidebar toggle, not a tab", () => {
  it("registry and tabs carry no Archive view entries", () => {
    for (const src of [registrySrc, tabsSrc]) {
      expect(src.toLowerCase()).not.toContain("archive");
    }
  });

  it("the toggle sits directly above the Settings footer in the Code sidebar", () => {
    const toggleAt = codeSidebarSrc.indexOf("<ArchiveToggle />");
    const settingsAt = codeSidebarSrc.indexOf("<SettingsFooter />");
    expect(toggleAt).toBeGreaterThan(-1);
    expect(settingsAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeLessThan(settingsAt);
  });

  it("archive mode swaps the sidebar's agent tree for the archived list", () => {
    expect(codeSidebarSrc).toMatch(/archiveMode\s*\?\s*\(\s*<ArchiveSidebar/);
    expect(codeSidebarSrc).toContain("<AgentsTree");
  });

  it("archive mode swaps the CodeView main area to the archive panel", () => {
    expect(codeViewSrc).toContain("archiveMode ? (");
    expect(codeViewSrc).toContain("<ArchiveView live={live} />");
  });

  it("the toggle flips the shared store mode and marks itself active", () => {
    expect(toggleSrc).toContain("toggleArchiveMode");
    expect(toggleSrc).toContain('archiveMode ? " on" : ""');
  });

  it("the archive panel is a main-area panel, not a view with its own layout", () => {
    expect(archiveViewSrc).not.toContain("AppLayout");
    expect(archiveViewSrc).toContain('className="archive-main"');
  });
});
