import { describe, it, expect } from "vitest";
import {
  displayName, initials, isProfileEmpty, isShared, mergeProfilePatch, profileSubtitle, withSharing,
} from "./profileText.js";
import { SHARE_TARGETS } from "./profileOptions.js";

const EMPTY = {
  rev: 0, updatedAt: 0,
  identity: { fullName: "", callName: "", handle: "", avatar: null },
  language: { chat: null, code: null },
  work: { roles: [], stack: [], level: null },
  style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
  instructions: "", sharing: { withholdFrom: [] }, budgetTokens: 800, onboardedAt: null,
};
const IBRAHIM = mergeProfilePatch(EMPTY, {
  identity: { fullName: "Ibrahim Albayrak", callName: "Ibrahim" },
  language: { chat: "tr", code: "en" },
  work: { roles: ["engineering"] },
});

describe("profileText", () => {
  it("names and initials", () => {
    expect(displayName(IBRAHIM)).toBe("Ibrahim");
    expect(initials(IBRAHIM)).toBe("IA");
    expect(initials(mergeProfilePatch(EMPTY, { identity: { callName: "ibo" } }))).toBe("I");
    expect(initials(EMPTY)).toBe("");
    expect(displayName(null)).toBe("");
  });

  it("subtitle: role, then distinct languages by native name", () => {
    expect(profileSubtitle(IBRAHIM)).toBe("Engineering · Türkçe / English");
    expect(profileSubtitle(mergeProfilePatch(EMPTY, { language: { chat: "mirror", code: "en" } }))).toBe("English");
    expect(profileSubtitle(EMPTY)).toBe("");
  });

  it("emptiness mirrors the daemon: handle/avatar don't count", () => {
    expect(isProfileEmpty(EMPTY)).toBe(true);
    expect(isProfileEmpty(mergeProfilePatch(EMPTY, { identity: { handle: "x" } }))).toBe(true);
    expect(isProfileEmpty(IBRAHIM)).toBe(false);
    expect(isProfileEmpty(null)).toBe(true);
  });

  it("patch merges groups one level deep, arrays replace", () => {
    const next = mergeProfilePatch(IBRAHIM, { work: { stack: ["Bun"] }, instructions: "x" });
    expect(next.work.roles).toEqual(["engineering"]);
    expect(next.work.stack).toEqual(["Bun"]);
    expect(next.instructions).toBe("x");
    expect(IBRAHIM.work.stack).toEqual([]);
  });

  it("sharing toggles a target's kinds in withholdFrom", () => {
    const gemini = SHARE_TARGETS.find((t) => t.id === "gemini");
    const off = withSharing(IBRAHIM, "gemini", false);
    expect(off).toEqual(["gemini-cli"]);
    const p = mergeProfilePatch(IBRAHIM, { sharing: { withholdFrom: off } });
    expect(isShared(p, gemini)).toBe(false);
    expect(withSharing(p, "gemini", true)).toEqual([]);
  });
});
