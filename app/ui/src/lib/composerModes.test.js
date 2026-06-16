import { describe, it, expect } from "vitest";
import { nextGitMode, composerMode, modeFlags } from "./composerModes.js";

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

describe("composerMode / modeFlags", () => {
  it("maps flags to the mode discriminant", () => {
    expect(composerMode({ gitMode: false, termMode: false })).toBe("chat");
    expect(composerMode({ gitMode: true, termMode: false })).toBe("git");
    expect(composerMode({ gitMode: false, termMode: true })).toBe("term");
  });

  it("term wins if both flags are somehow set", () => {
    expect(composerMode({ gitMode: true, termMode: true })).toBe("term");
  });

  it("maps modes back to exclusive flag pairs", () => {
    expect(modeFlags("chat")).toEqual({ gitMode: false, termMode: false });
    expect(modeFlags("git")).toEqual({ gitMode: true, termMode: false });
    expect(modeFlags("term")).toEqual({ gitMode: false, termMode: true });
  });

  it("round-trips through both converters", () => {
    for (const mode of ["chat", "git", "term"]) {
      expect(composerMode(modeFlags(mode))).toBe(mode);
    }
  });
});
