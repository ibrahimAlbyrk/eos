import { describe, it, expect } from "vitest";
import {
  INTERVIEW_STEPS, answersToPatch, canContinue, cardLines, initialAnswers, shouldOfferInterview,
} from "./profileInterview.js";

const EMPTY = {
  rev: 0, updatedAt: 0,
  identity: { fullName: "", callName: "", handle: "", avatar: null },
  language: { chat: null, code: null },
  work: { roles: [], stack: [], level: null },
  style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
  instructions: "", sharing: { withholdFrom: [] }, budgetTokens: 800, onboardedAt: null,
};

describe("profileInterview", () => {
  it("four steps, name first", () => {
    expect(INTERVIEW_STEPS.map((s) => s.id)).toEqual(["name", "work", "language", "style"]);
  });

  it("answers → one patch that marks the interview done", () => {
    const a = { ...initialAnswers(EMPTY), fullName: " Ibrahim Albayrak ", callName: "Ibrahim", roles: ["engineering"], chat: "tr", code: "en", replies: "terse" };
    expect(answersToPatch(a, 42)).toEqual({
      identity: { fullName: "Ibrahim Albayrak", callName: "Ibrahim" },
      work: { roles: ["engineering"], stack: [] },
      language: { chat: "tr", code: "en" },
      style: { replies: "terse", autonomy: null },
      onboardedAt: 42,
    });
  });

  it("only the name step needs an answer", () => {
    const a = initialAnswers(EMPTY);
    expect(canContinue("name", a)).toBe(false);
    expect(canContinue("name", { ...a, callName: "I" })).toBe(true);
    expect(canContinue("work", a)).toBe(true);
  });

  it("card lines fill as steps are reached; the current one is lit", () => {
    const a = { ...initialAnswers(EMPTY), callName: "Ibrahim", roles: ["engineering"], stack: ["Bun"], chat: "mirror" };
    const lines = cardLines(a, 1);
    expect(lines.map((l) => l.filled)).toEqual([true, true, false, false]);
    expect(lines[1]).toMatchObject({ value: "Engineering · Bun", current: true });
    expect(cardLines(a, 2)[2].value).toBe("Mirrors your language");
  });

  it("offered once: empty, never onboarded, never skipped", () => {
    expect(shouldOfferInterview(EMPTY, {})).toBe(true);
    expect(shouldOfferInterview({ ...EMPTY, onboardedAt: 1 }, {})).toBe(false);
    expect(shouldOfferInterview(EMPTY, { "onboarding.profileDismissed": true })).toBe(false);
    expect(shouldOfferInterview({ ...EMPTY, instructions: "x" }, {})).toBe(false);
    expect(shouldOfferInterview(null, {})).toBe(false);
  });
});
