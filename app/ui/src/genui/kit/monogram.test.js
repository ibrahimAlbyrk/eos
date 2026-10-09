import { describe, it, expect } from "vitest";
import { MONO_TONES, initials, monoTone, monogram } from "./monogram.js";

describe("monogram", () => {
  it("takes the first letters of the first two words", () => {
    expect(initials("Moda Kıyı")).toBe("MK");
    expect(initials("Lâl Balık")).toBe("LB");
    expect(initials("Ocak 34")).toBe("O3");
    expect(initials("Saat Kulesi & Konak Meydanı")).toBe("SK");
  });

  it("uses one letter for a domain and survives empty names", () => {
    expect(initials("modakiyi.example")).toBe("M");
    expect(initials("https://www.lalbalik.com/menu")).toBe("L");
    expect(initials("")).toBe("?");
    expect(initials(null)).toBe("?");
  });

  it("hashes the name to a stable tone", () => {
    expect(MONO_TONES).toContain(monoTone("Moda Kıyı"));
    expect(monoTone("Moda Kıyı")).toBe(monoTone("  moda kıyı "));
    expect(monogram("Yel Meyhane")).toEqual({ initials: "YM", tone: monoTone("Yel Meyhane") });
    const tones = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(monoTone));
    expect(tones.size).toBeGreaterThan(2);
  });
});
