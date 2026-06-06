import { describe, it, expect, beforeAll } from "vitest";

// theme.js touches document/window at module scope — stub before import (node env).
function makeDocStub() {
  const attrs = {};
  return {
    documentElement: {
      getAttribute: (k) => attrs[k] ?? null,
      setAttribute: (k, v) => { attrs[k] = v; },
      animate: () => {},
    },
    addEventListener: () => {},
  };
}

let theme;
beforeAll(async () => {
  globalThis.document = makeDocStub();
  globalThis.window = {
    innerWidth: 1000,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  };
  theme = await import("./theme.js");
});

describe("resolveTheme", () => {
  it("returns explicit values untouched", () => {
    expect(theme.resolveTheme("dark", true)).toBe("dark");
    expect(theme.resolveTheme("light", false)).toBe("light");
  });

  it("system follows prefers-color-scheme", () => {
    expect(theme.resolveTheme("system", true)).toBe("light");
    expect(theme.resolveTheme("system", false)).toBe("dark");
  });

  it("unknown values behave like system", () => {
    expect(theme.resolveTheme(undefined, true)).toBe("light");
    expect(theme.resolveTheme("weird", false)).toBe("dark");
  });
});

describe("setTheme", () => {
  it("sets data-theme instantly when startViewTransition is unavailable", () => {
    theme.setTheme("light", { animate: true });
    expect(theme.currentTheme()).toBe("light");
  });

  it("no-ops when the theme already matches", () => {
    document.documentElement.setAttribute("data-theme", "light");
    theme.setTheme("light");
    expect(theme.currentTheme()).toBe("light");
  });

  it("defaults missing attribute to dark", () => {
    globalThis.document = makeDocStub();
    expect(theme.currentTheme()).toBe("dark");
  });
});
