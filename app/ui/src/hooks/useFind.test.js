import { describe, it, expect } from "vitest";
import { selectionToQuery } from "./useFind.js";

describe("selectionToQuery", () => {
  it("keeps a one-line selection as typed", () => {
    expect(selectionToQuery("index.lock")).toBe("index.lock");
    expect(selectionToQuery(" a b ")).toBe(" a b ");
  });

  it("drops the trailing line break of a triple-click", () => {
    expect(selectionToQuery("whole line\n")).toBe("whole line");
  });

  it("ignores empty, blank and multi-line selections", () => {
    expect(selectionToQuery("")).toBe("");
    expect(selectionToQuery("  \n")).toBe("");
    expect(selectionToQuery("one\ntwo")).toBe("");
  });
});
