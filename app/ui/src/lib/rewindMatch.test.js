import { describe, it, expect } from "vitest";
import { findRewindTarget } from "./rewindMatch.js";

const t = (uuid, text, display = text) => ({ uuid, text, display });

describe("findRewindTarget", () => {
  it("matches by exact normalized text", () => {
    const targets = [t("a", "fix the bug"), t("b", "deploy   it\n")];
    expect(findRewindTarget(targets, "deploy it")?.uuid).toBe("b");
  });

  it("disambiguates duplicates by occurrence", () => {
    const targets = [t("a", "devam"), t("b", "other"), t("c", "devam")];
    expect(findRewindTarget(targets, "devam", 0)?.uuid).toBe("a");
    expect(findRewindTarget(targets, "devam", 1)?.uuid).toBe("c");
  });

  it("returns null when occurrence overflows instead of guessing", () => {
    const targets = [t("a", "devam")];
    expect(findRewindTarget(targets, "devam", 1)).toBe(null);
  });

  it("falls back to either-way prefix match (attachment suffixes)", () => {
    const targets = [t("a", "fix the bug [Image #1]")];
    expect(findRewindTarget(targets, "fix the bug")?.uuid).toBe("a");
  });

  it("prefers exact over prefix matches", () => {
    const targets = [t("a", "fix the bug [Image #1]"), t("b", "fix the bug")];
    expect(findRewindTarget(targets, "fix the bug")?.uuid).toBe("b");
  });

  it("matches the display form of slash commands", () => {
    const targets = [t("a", "<command-name>/commit</command-name>", "/commit")];
    expect(findRewindTarget(targets, "/commit")?.uuid).toBe("a");
  });

  it("returns null for empty text or no match", () => {
    expect(findRewindTarget([t("a", "x")], "")).toBe(null);
    expect(findRewindTarget([t("a", "x")], "y")).toBe(null);
  });
});
