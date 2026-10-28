import { describe, expect, it } from "vitest";
import { parseSideQuestion, sideQuestionQuote } from "./sideQuestion.js";

describe("parseSideQuestion", () => {
  it("reads the question after /btw", () => {
    expect(parseSideQuestion("/btw why is it in memory?")).toEqual({ question: "why is it in memory?" });
    expect(parseSideQuestion("  /btw  two\nlines  ")).toEqual({ question: "two\nlines" });
  });

  it("a bare /btw has an empty question", () => {
    expect(parseSideQuestion("/btw")).toEqual({ question: "" });
  });

  it("anything else is not a side question", () => {
    expect(parseSideQuestion("/btwx why")).toBeNull();
    expect(parseSideQuestion("ask /btw why")).toBeNull();
    expect(parseSideQuestion("/compact")).toBeNull();
    expect(parseSideQuestion("")).toBeNull();
  });
});

describe("sideQuestionQuote", () => {
  it("quotes the question and every answer line, blank lines included", () => {
    expect(sideQuestionQuote("why?", "first\n\nsecond\n")).toBe(
      "> **Side question:** why?\n>\n> first\n>\n> second\n\n",
    );
  });
});
