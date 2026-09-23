import { describe, it, expect } from "vitest";
// Raw-source assertions (the archiveFunnel.test.js precedent): Export must
// reach the same download path as the /export slash command from every menu —
// live right-click, header dropdown, and the archived-row right-click.
// Rendering menus isn't feasible in the node test env, so the wiring is
// asserted at the source level.
import ctxMenuSrc from "./AgentContextMenu.jsx?raw";
import headMenuSrc from "./HeaderAgentMenu.jsx?raw";
import archiveCtxSrc from "../../archive/ArchiveContextMenu.jsx?raw";
import composerSrc from "../center/Composer.jsx?raw";
import clientSrc from "../../../api/client.js?raw";

describe("Export menu items reuse the /export download path", () => {
  it("live right-click menu exports via api.exportWorker with the orchestrator tree rule", () => {
    expect(ctxMenuSrc).toContain("Export");
    expect(ctxMenuSrc).toContain("api.exportWorker(agentId, { tree: !!agent?.is_orchestrator })");
  });

  it("header dropdown exports via api.exportWorker with the orchestrator tree rule", () => {
    expect(headMenuSrc).toContain('id: "export", label: "Export"');
    expect(headMenuSrc).toContain("api.exportWorker(agent.id, { tree: !!agent.is_orchestrator })");
  });

  it("archived right-click menu exports the stored transcript via the same client call", () => {
    expect(archiveCtxSrc).toContain("Export");
    expect(archiveCtxSrc).toContain("api.exportWorker(id, { tree: !!row?.is_orchestrator })");
    // No live-session dependency: the handler resolves the row from the
    // archived store, never from live.workers.
    expect(archiveCtxSrc).toContain("rows.find((w) => w.id === id)");
  });

  it("menus match the /export slash command's tree rule (Composer)", () => {
    expect(composerSrc).toContain("const tree = !!selected.is_orchestrator");
    expect(composerSrc).toContain("api.exportWorker(selected.id, { tree })");
  });

  it("export is confirm-free and non-danger in every menu", () => {
    expect(ctxMenuSrc).toMatch(/className="menu-item" onClick={exportAgent}/);
    expect(archiveCtxSrc).toMatch(/className="menu-item" onClick={\(\) => runExport\(agentId\)}/);
    expect(headMenuSrc).not.toMatch(/id: "export"[^\n]*danger/);
  });

  it("client exportWorker downloads from the workers export route", () => {
    expect(clientSrc).toContain("async exportWorker");
    expect(clientSrc).toContain("ROUTES.workerExport(id)");
  });
});
