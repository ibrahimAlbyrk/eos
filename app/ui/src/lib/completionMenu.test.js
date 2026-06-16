import { describe, it, expect, vi } from "vitest";
import { menuVisibility, escapeMenu, menuDismissedOnQueryChange } from "./completionMenu.js";

describe("menuVisibility", () => {
  it("shows slash menu when active and not dismissed", () => {
    expect(menuVisibility({ activeMenu: "slash", menuDismissed: false })).toEqual({
      showMenu: true,
      showFileMenu: false,
    });
  });

  it("shows file menu when active and not dismissed", () => {
    expect(menuVisibility({ activeMenu: "file", menuDismissed: false })).toEqual({
      showMenu: false,
      showFileMenu: true,
    });
  });

  it("hides both menus when dismissed regardless of activeMenu", () => {
    expect(menuVisibility({ activeMenu: "slash", menuDismissed: true }).showMenu).toBe(false);
    expect(menuVisibility({ activeMenu: "file", menuDismissed: true }).showFileMenu).toBe(false);
  });

  it("hides both menus when no menu is active", () => {
    expect(menuVisibility({ activeMenu: null, menuDismissed: false })).toEqual({
      showMenu: false,
      showFileMenu: false,
    });
  });
});

// Mirrors Composer.applyEscapeMenu: the same dispatch the ESC handler runs.
// Reproduces bug B2 — if escapeMenu() ever drops keepText, the composer text is
// wiped on ESC (setTextAndSync("", 0)) and this test fails.
function dispatchEscape({ setTextAndSync, setMenuDismissed }) {
  const { keepText, dismissed } = escapeMenu();
  if (!keepText) setTextAndSync("", 0);
  setMenuDismissed(dismissed);
}

describe("escapeMenu", () => {
  it("preserves composer text and dismisses the menu", () => {
    expect(escapeMenu()).toEqual({ keepText: true, dismissed: true });
  });

  it("does not clear the composer and hides the menu when applied", () => {
    const setTextAndSync = vi.fn();
    const setMenuDismissed = vi.fn();
    dispatchEscape({ setTextAndSync, setMenuDismissed });
    expect(setTextAndSync).not.toHaveBeenCalled();
    expect(setMenuDismissed).toHaveBeenCalledWith(true);
  });
});

describe("menuDismissedOnQueryChange", () => {
  it("re-opens the menu by clearing the dismiss flag when the query changes", () => {
    expect(menuDismissedOnQueryChange()).toBe(false);
  });
});
