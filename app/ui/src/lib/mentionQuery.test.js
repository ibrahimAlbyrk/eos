import { describe, it, expect } from "vitest";
import { resolveMentionQuery, parentScope, mentionCrumbs } from "./mentionQuery.js";

describe("resolveMentionQuery", () => {
  it("empty fragment browses the root", () => {
    expect(resolveMentionQuery("")).toEqual({ mode: "browse", dir: "", filter: "" });
  });

  it("a slash-free term is a repo-wide search", () => {
    expect(resolveMentionQuery("Comp")).toEqual({ mode: "search", dir: "", filter: "Comp" });
  });

  it("a trailing slash browses that directory with no filter", () => {
    expect(resolveMentionQuery("src/")).toEqual({ mode: "browse", dir: "src", filter: "" });
  });

  it("text after the last slash is an in-directory filter", () => {
    expect(resolveMentionQuery("src/views/co")).toEqual({ mode: "browse", dir: "src/views", filter: "co" });
  });

  it("preserves case (paths are case-sensitive)", () => {
    expect(resolveMentionQuery("Src/Views/")).toEqual({ mode: "browse", dir: "Src/Views", filter: "" });
  });
});

describe("parentScope", () => {
  it("drops the last segment", () => {
    expect(parentScope("src/views")).toBe("src");
  });

  it("a single segment goes to the root", () => {
    expect(parentScope("src")).toBe("");
  });

  it("the root has no parent", () => {
    expect(parentScope("")).toBeNull();
  });
});

describe("mentionCrumbs", () => {
  it("splits a scope into segments", () => {
    expect(mentionCrumbs("src/views")).toEqual(["src", "views"]);
  });

  it("the root has no crumbs", () => {
    expect(mentionCrumbs("")).toEqual([]);
  });
});
