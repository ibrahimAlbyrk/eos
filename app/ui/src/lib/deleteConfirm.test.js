import { describe, it, expect } from "vitest";
import { DELETE_CONFIRM_KEY, PURGE_CONFIRM_KEY, shouldConfirmDelete, shouldConfirmPurge } from "./deleteConfirm.js";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "../settings/registry.jsx";
// Raw-source wiring assertions (the archiveFunnel.test.js precedent): rendering
// the menus isn't feasible in the node test env, so the suppress wiring is
// asserted at the source level.
import ctxMenuSrc from "../views/code/popovers/AgentContextMenu.jsx?raw";
import headMenuSrc from "../views/code/popovers/HeaderAgentMenu.jsx?raw";
import archiveCtxSrc from "../views/archive/ArchiveContextMenu.jsx?raw";
import dialogSrc from "../views/code/popovers/DeleteConfirmDialog.jsx?raw";

const generalItem = (key) => SETTINGS_SECTIONS
  .find((s) => s.id === "general")
  .groups.flatMap((g) => g.items)
  .find((i) => i.key === key);

describe("delete confirm suppress logic", () => {
  it("asks by default — unset and explicit true both confirm", () => {
    expect(shouldConfirmDelete({})).toBe(true);
    expect(shouldConfirmDelete(undefined)).toBe(true);
    expect(shouldConfirmDelete({ [DELETE_CONFIRM_KEY]: true })).toBe(true);
  });

  it("only an explicit false suppresses the dialog", () => {
    expect(shouldConfirmDelete({ [DELETE_CONFIRM_KEY]: false })).toBe(false);
    // Junk values never silently disable the confirm.
    expect(shouldConfirmDelete({ [DELETE_CONFIRM_KEY]: null })).toBe(true);
    expect(shouldConfirmDelete({ [DELETE_CONFIRM_KEY]: 0 })).toBe(true);
  });

  it("both preferences are registry toggles in General (re-enable path) defaulting to true", () => {
    for (const key of [DELETE_CONFIRM_KEY, PURGE_CONFIRM_KEY]) {
      expect(SETTING_DEFAULTS[key]).toBe(true);
      expect(generalItem(key).control.type).toBe("toggle");
      // Not archive.* — persists via the plain settings store, not config.json.
      expect(key.startsWith("archive.")).toBe(false);
    }
  });

  it("live delete and archive purge suppress independently", () => {
    expect(PURGE_CONFIRM_KEY).not.toBe(DELETE_CONFIRM_KEY);
    expect(shouldConfirmPurge({})).toBe(true);
    expect(shouldConfirmPurge({ [PURGE_CONFIRM_KEY]: false })).toBe(false);
    // Suppressing one never suppresses the other.
    expect(shouldConfirmPurge({ [DELETE_CONFIRM_KEY]: false })).toBe(true);
    expect(shouldConfirmDelete({ [PURGE_CONFIRM_KEY]: false })).toBe(true);
  });

  it("both delete menus gate the dialog on the preference and kill directly when suppressed", () => {
    for (const src of [ctxMenuSrc, headMenuSrc]) {
      expect(src).toContain("shouldConfirmDelete(settings)");
      expect(src).toContain("DeleteConfirmDialog");
    }
  });

  it("the archive purge confirm gates on its own key and purges directly when suppressed", () => {
    expect(archiveCtxSrc).toContain("shouldConfirmPurge(settings)");
    expect(archiveCtxSrc).toContain("DeleteConfirmDialog");
    expect(archiveCtxSrc).not.toContain("shouldConfirmDelete");
  });

  it("ticking don't-ask persists false only on confirm, from all three menus", () => {
    for (const src of [ctxMenuSrc, headMenuSrc]) {
      expect(src).toContain("if (dontAskAgain) setSetting(DELETE_CONFIRM_KEY, false)");
    }
    expect(archiveCtxSrc).toContain("if (dontAskAgain) setSetting(PURGE_CONFIRM_KEY, false)");
    // The dialog keeps the tick local and hands it to onConfirm — cancel never persists.
    expect(dialogSrc).toContain("onConfirm(dontAskAgain)");
    expect(dialogSrc).not.toContain("setSetting");
  });

  it("the dialog reuses the settings panel's row/toggle classes", () => {
    for (const cls of ["stg-title", "stg-row", "stg-row__label", "stg-toggle", "stg-toggle__knob"]) {
      expect(dialogSrc).toContain(cls);
    }
  });
});
