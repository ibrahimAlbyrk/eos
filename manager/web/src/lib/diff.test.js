import { describe, it, expect } from "vitest";
import {
  computeLCS,
  buildDiffHunks,
  patchToHunks,
  parseAskAnswers,
  stripCatLineNumbers,
} from "./diff.jsx";

describe("computeLCS", () => {
  it("returns the longest common subsequence of two arrays", () => {
    expect(computeLCS(["a", "b", "c"], ["a", "x", "c"])).toEqual(["a", "c"]);
  });

  it("works on strings (char arrays)", () => {
    expect(computeLCS("abcde", "ace")).toEqual(["a", "c", "e"]);
  });

  it("returns empty when there is nothing in common", () => {
    expect(computeLCS(["a", "b"], ["x", "y"])).toEqual([]);
  });

  it("returns the full sequence when both inputs are identical", () => {
    expect(computeLCS(["a", "b", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles an empty input", () => {
    expect(computeLCS([], ["a"])).toEqual([]);
  });
});

describe("buildDiffHunks", () => {
  it("returns no hunks when both sides are empty", () => {
    expect(buildDiffHunks([], [])).toEqual([]);
  });

  it("marks a single replaced line as a del followed by an add", () => {
    const hunks = buildDiffHunks(["a", "b", "c"], ["a", "x", "c"]);
    const shape = hunks.map((h) => ({ type: h.type, num: h.num, text: h.text }));
    expect(shape).toEqual([
      { type: "ctx", num: 1, text: "a" },
      { type: "del", num: 2, text: "b" },
      { type: "add", num: 2, text: "x" },
      { type: "ctx", num: 3, text: "c" },
    ]);
  });

  it("emits inline segments for a replaced (paired del/add) line", () => {
    const hunks = buildDiffHunks(["foo"], ["bar"]);
    const del = hunks.find((h) => h.type === "del");
    const add = hunks.find((h) => h.type === "add");
    expect(del.segments).toBeDefined();
    expect(add.segments).toBeDefined();
  });

  it("treats a pure insertion as add-only with no del hunk", () => {
    const hunks = buildDiffHunks(["a", "b"], ["a", "new", "b"]);
    expect(hunks.map((h) => h.type)).toEqual(["ctx", "add", "ctx"]);
    expect(hunks.find((h) => h.type === "add").text).toBe("new");
  });

  it("treats a pure deletion as del-only with no add hunk", () => {
    const hunks = buildDiffHunks(["a", "gone", "b"], ["a", "b"]);
    expect(hunks.map((h) => h.type)).toEqual(["ctx", "del", "ctx"]);
    expect(hunks.find((h) => h.type === "del").text).toBe("gone");
  });
});

describe("patchToHunks", () => {
  it("uses the patch's absolute line numbers, not snippet-relative ones", () => {
    const hunks = patchToHunks([
      { oldStart: 35, newStart: 35, lines: [" a", "-b", "+x", " c"] },
    ]);
    const shape = hunks.map((h) => ({ type: h.type, num: h.num, text: h.text }));
    expect(shape).toEqual([
      { type: "ctx", num: 35, text: "a" },
      { type: "del", num: 36, text: "b" },
      { type: "add", num: 36, text: "x" },
      { type: "ctx", num: 37, text: "c" },
    ]);
  });

  it("emits inline segments for a paired del/add line", () => {
    const hunks = patchToHunks([
      { oldStart: 10, newStart: 10, lines: ["-foo", "+bar"] },
    ]);
    expect(hunks.find((h) => h.type === "del").segments).toBeDefined();
    expect(hunks.find((h) => h.type === "add").segments).toBeDefined();
  });

  it("restarts numbering per hunk so the gap between hunks is honored", () => {
    const hunks = patchToHunks([
      { oldStart: 1, newStart: 1, lines: ["-a", "+A"] },
      { oldStart: 100, newStart: 100, lines: ["-z", "+Z"] },
    ]);
    expect(hunks.map((h) => h.num)).toEqual([1, 1, 100, 100]);
  });

  it("skips the no-newline marker line", () => {
    const hunks = patchToHunks([
      { oldStart: 5, newStart: 5, lines: ["-old", "+new", "\\ No newline at end of file"] },
    ]);
    expect(hunks.map((h) => h.type)).toEqual(["del", "add"]);
  });

  it("returns an empty array for non-array input", () => {
    expect(patchToHunks(null)).toEqual([]);
    expect(patchToHunks(undefined)).toEqual([]);
  });
});

describe("parseAskAnswers", () => {
  it("correlates answers in the 'My answers' arrow format", () => {
    const questions = [{ question: "What color?" }, { question: "What size?" }];
    const result =
      "Done.\nMy answers to your questions:\nWhat color? → blue\nWhat size? → large";
    expect(parseAskAnswers(questions, result)).toEqual(["blue", "large"]);
  });

  it("parses the 'have been answered' quoted format", () => {
    const questions = [{ question: "What color?" }, { question: "What size?" }];
    const result =
      'Your questions have been answered: "What color?" = "blue", "What size?" = "large".';
    const parsed = parseAskAnswers(questions, result);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toBe("large");
  });

  it("falls back to substring correlation when keys are not exact", () => {
    const questions = [{ question: "Which database should we use for storage?" }];
    const result = "My answers to your questions:\nWhich database → postgres";
    expect(parseAskAnswers(questions, result)).toEqual(["postgres"]);
  });

  it("returns null for a question with no matching answer", () => {
    const questions = [{ question: "Unrelated?" }];
    const result = "My answers to your questions:\nSomething else → foo";
    expect(parseAskAnswers(questions, result)).toEqual([null]);
  });

  it("returns an empty array when there is no result text", () => {
    expect(parseAskAnswers([{ question: "x" }], "")).toEqual([]);
  });

  it("returns an empty array when there are no questions", () => {
    expect(parseAskAnswers([], "anything")).toEqual([]);
  });
});

describe("stripCatLineNumbers", () => {
  it("strips `cat -n` style numeric prefixes and keeps the real line numbers", () => {
    const text = "     1\tconst x = 1;\n     2\tconst y = 2;";
    expect(stripCatLineNumbers(text)).toEqual([
      { num: 1, text: "const x = 1;" },
      { num: 2, text: "const y = 2;" },
    ]);
  });

  it("falls back to sequential numbering for plain (un-numbered) text", () => {
    expect(stripCatLineNumbers("line one\nline two")).toEqual([
      { num: 1, text: "line one" },
      { num: 2, text: "line two" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(stripCatLineNumbers("")).toEqual([]);
  });
});
