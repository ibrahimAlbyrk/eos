import { describe, it, expect } from "vitest";
import { nextGitMode } from "./composerModes.js";

describe("nextGitMode", () => {
  it("toggles on when no mode is active", () => {
    expect(nextGitMode({ gitMode: false, termMode: false }, undefined)).toBe(true);
  });

  it("toggles off when git mode is active", () => {
    expect(nextGitMode({ gitMode: true, termMode: false }, undefined)).toBe(false);
  });

  it("honors explicit on/off", () => {
    expect(nextGitMode({ gitMode: false, termMode: false }, true)).toBe(true);
    expect(nextGitMode({ gitMode: true, termMode: false }, false)).toBe(false);
  });

  it("blocks entering git mode while terminal mode is active", () => {
    expect(nextGitMode({ gitMode: false, termMode: true }, undefined)).toBe(false);
    expect(nextGitMode({ gitMode: false, termMode: true }, true)).toBe(false);
  });

  it("still allows turning git mode off while terminal mode is active", () => {
    expect(nextGitMode({ gitMode: true, termMode: true }, false)).toBe(false);
  });
});
