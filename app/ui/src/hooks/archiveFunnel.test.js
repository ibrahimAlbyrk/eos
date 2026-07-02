import { describe, it, expect } from "vitest";
// Raw-source assertions (the routes.test.js `?raw` precedent): the funnel swap
// is a wiring contract — Cmd+W and both menus must archive by default, and the
// menu-only permanent delete must share the same removal funnel. Rendering
// hooks isn't feasible in the node test env, so the wiring is asserted at the
// source level.
import removalSrc from "./useArchiveAgent.js?raw";
import hotkeySrc from "./useArchiveAgentHotkey.js?raw";
import useLiveSrc from "./useLive.js?raw";
import clientSrc from "../api/client.js?raw";
import settingsSrc from "../state/settings.jsx?raw";
import ctxMenuSrc from "../views/code/popovers/AgentContextMenu.jsx?raw";
import headMenuSrc from "../views/code/popovers/HeaderAgentMenu.jsx?raw";
import codeViewSrc from "../views/code/CodeView.jsx?raw";

describe("Cmd+W funnel archives; delete is menu-only and shares the funnel", () => {
  it("archive and kill are the same removal core wired to different actions", () => {
    expect(removalSrc).toContain("useAgentRemoval(live, live.archiveAgent");
    expect(removalSrc).toContain("useAgentRemoval(live, live.killAgent");
  });

  it("the removal core keeps the subtree snapshot + per-agent cache purge", () => {
    expect(removalSrc).toContain("subtreeIds(live.workers, agentId)");
    for (const purge of ["deleteDraft", "clearScrollPos", "purgeAgent", "purgeDiff", "purgeConflict", "purgeGitStatus", "purgeTerminal", "dropThinking"]) {
      expect(removalSrc).toContain(`${purge}(`);
    }
  });

  it("hotkey keeps mod+w and the empty-pane closeLeaf branch", () => {
    expect(hotkeySrc).toContain('combo("mod+w")');
    expect(hotkeySrc).toContain("closeLeaf(focusedLeafId)");
  });

  it("hotkey routes per archive.cmdW: archive unless config says delete", () => {
    // Ternary defaulting to archive covers both the unset key and a config
    // that failed to load; delete mode is the confirm-free pre-archive UX.
    expect(hotkeySrc).toContain('settings["archive.cmdW"] === "delete" ? killAgent : archiveAgent');
    expect(hotkeySrc).toContain("useArchiveAgent(live)");
    expect(hotkeySrc).toContain("useKillAgent(live)");
    // No confirm dialog in the hotkey path — the menus own the confirm.
    expect(hotkeySrc).not.toContain("Confirm");
  });

  it("all three entry points route through the archive funnel", () => {
    expect(ctxMenuSrc).toContain("useArchiveAgent");
    expect(headMenuSrc).toContain("useArchiveAgent");
    expect(codeViewSrc).toContain("useArchiveAgentHotkey");
    for (const src of [ctxMenuSrc, headMenuSrc, codeViewSrc]) {
      expect(src).not.toContain("useDeleteAgent");
    }
  });

  it("archive stays confirm-free and non-danger in both menus", () => {
    // The archive item runs the funnel directly — no confirm state in between.
    expect(ctxMenuSrc).toMatch(/className="menu-item" onClick={archive}/);
    expect(headMenuSrc).toMatch(/id: "archive", label: "Archive", kbd: "⌘W", run/);
  });

  it("delete is danger-styled and confirm-gated in both menus", () => {
    expect(ctxMenuSrc).toContain('className="menu-item danger"');
    expect(ctxMenuSrc).toContain("BranchConfirmDialog");
    expect(headMenuSrc).toContain('label: "Delete", danger: true');
    expect(headMenuSrc).toContain("BranchConfirmDialog");
  });

  it("useLive exposes the archive/restore/purge/kill wrappers", () => {
    for (const fn of ["archiveAgent", "restoreAgent", "purgeAgent", "killAgent"]) {
      expect(useLiveSrc).toContain(fn);
    }
    expect(clientSrc).toContain("killWorker");
  });
});

describe("archive settings persist to config.json, not the settings.json store", () => {
  it("setSetting routes archive.* keys to the archive-config endpoint", () => {
    expect(settingsSrc).toContain('key.startsWith("archive.")');
    expect(settingsSrc).toContain('api.patchArchiveConfig({ [key.slice("archive.".length)]: value })');
  });

  it("archive config loads alongside settings and merges in flat-key form", () => {
    expect(settingsSrc).toContain("api.getArchiveConfig()");
    expect(settingsSrc).toContain("`archive.${k}`");
  });

  it("client reads and writes /api/settings/archive", () => {
    expect(clientSrc).toContain("async getArchiveConfig");
    expect(clientSrc).toContain("async patchArchiveConfig");
    expect(clientSrc.match(/ROUTES\.settingsArchive/g)?.length).toBe(2);
  });
});
