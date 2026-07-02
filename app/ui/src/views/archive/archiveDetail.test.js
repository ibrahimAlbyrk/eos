import { describe, it, expect } from "vitest";
// Raw-source assertions (the archiveFunnel.test.js precedent): the archived
// detail view + menu actions are wiring contracts; rendering isn't feasible in
// the node test env.
import archiveViewSrc from "./ArchiveView.jsx?raw";
import archiveSidebarSrc from "./ArchiveSidebar.jsx?raw";
import archiveCtxSrc from "./ArchiveContextMenu.jsx?raw";

describe("archived selection renders the normal agent view", () => {
  it("uses the live view's transcript host + composer, not a summary card", () => {
    expect(archiveViewSrc).toContain("TranscriptHost");
    expect(archiveViewSrc).toContain("<Composer");
    expect(archiveViewSrc).not.toContain("archive-card");
  });

  it("feeds the archived subtree into the same components via a shimmed live", () => {
    expect(archiveViewSrc).toMatch(/\.\.\.live,\s*workers:\s*rows/);
    expect(archiveViewSrc).toContain("live={archLive}");
  });

  it("the composer is inert, dimmed, and out of the focused-hotkey funnels", () => {
    expect(archiveViewSrc).toContain('inert=""');
    expect(archiveViewSrc).toContain('className="composer-archived"');
    expect(archiveViewSrc).toContain("focused={false}");
  });
});

describe("archived-row context menu", () => {
  it("sidebar rows open the archive context menu", () => {
    expect(archiveSidebarSrc).toContain('openPop("archive-ctx"');
    expect(archiveSidebarSrc).toContain("onContextMenu");
  });

  it("Restore runs directly; permanent delete is confirm-gated and hits purge", () => {
    expect(archiveCtxSrc).toContain("live.restoreAgent(");
    expect(archiveCtxSrc).toContain("live.purgeAgent(");
    expect(archiveCtxSrc).toContain("BranchConfirmDialog");
    // Restore must NOT sit behind the confirm state; only delete sets it.
    expect(archiveCtxSrc).toMatch(/onClick={\(\) => runRestore\(agentId\)}/);
    expect(archiveCtxSrc).toMatch(/setConfirmId\(agentId\)/);
  });

  it("both actions end in refreshArchived (selection fallback lives in the store)", () => {
    const refetches = archiveCtxSrc.match(/await refreshArchived\(\)/g) ?? [];
    expect(refetches.length).toBeGreaterThanOrEqual(2);
  });
});
