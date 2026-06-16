import { describe, it, expect } from "vitest";
import { isTriggerBoundary, triggerContext } from "./triggerContext.js";

describe("isTriggerBoundary", () => {
  it("true at start of text", () => {
    expect(isTriggerBoundary("/cmd", 0)).toBe(true);
  });

  it("true after space or newline", () => {
    expect(isTriggerBoundary("a /b", 2)).toBe(true);
    expect(isTriggerBoundary("a\n/b", 2)).toBe(true);
  });

  it("false mid-word", () => {
    expect(isTriggerBoundary("foo/bar", 3)).toBe(false);
  });
});

describe("triggerContext", () => {
  it("activates for slash at start", () => {
    expect(triggerContext("/co", 3, "/")).toEqual({ start: 0, query: "co" });
  });

  it("activates for slash after space", () => {
    expect(triggerContext("hello /co", 9, "/")).toEqual({ start: 6, query: "co" });
  });

  it("activates for slash after newline", () => {
    expect(triggerContext("hello\n/co", 9, "/")).toEqual({ start: 6, query: "co" });
  });

  it("ignores slash mid-word", () => {
    expect(triggerContext("foo/bar", 7, "/")).toBeNull();
  });

  it("ignores slashes inside URLs", () => {
    expect(triggerContext("see https://x", 13, "/")).toBeNull();
  });

  it("deactivates once fragment contains whitespace", () => {
    expect(triggerContext("/cmd arg", 8, "/")).toBeNull();
  });

  it("returns null when char absent", () => {
    expect(triggerContext("hello", 5, "/")).toBeNull();
  });

  it("uppercase query is lowercased", () => {
    expect(triggerContext("/CO", 3, "/")).toEqual({ start: 0, query: "co" });
  });

  it("applies same boundary to @", () => {
    expect(triggerContext("@src", 4, "@")).toEqual({ start: 0, query: "src" });
    expect(triggerContext("a@b.com", 7, "@")).toBeNull();
  });

  it("only looks before the cursor", () => {
    expect(triggerContext("/co tail", 3, "/")).toEqual({ start: 0, query: "co" });
  });
});
