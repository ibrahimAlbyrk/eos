import { describe, it, expect } from "vitest";
import { getToolView } from "./toolViews.jsx";
import { GenericDetail } from "./ToolDetail.jsx";

describe("getToolView", () => {
  it("falls back to the generic view for unknown tools", () => {
    const v = getToolView("mcp__context7__query-docs");
    expect(v.Detail).toBe(GenericDetail);
    expect(v.label({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Used", file: "mcp__context7__query-docs" });
    expect(v.runningLabel({ name: "mcp__context7__query-docs" })).toEqual({ verb: "Running", file: "mcp__context7__query-docs" });
    expect(v.filePath({ input: {} })).toBe(null);
    expect(v.stats({ input: {} })).toBe(null);
  });

  it("returns the same default view for any unregistered name", () => {
    expect(getToolView("foo").Detail).toBe(getToolView("bar").Detail);
    expect(getToolView(undefined).Detail).toBe(GenericDetail);
  });

  it("uses a bespoke Detail for known tools", () => {
    expect(getToolView("Read").Detail).not.toBe(GenericDetail);
  });

  it("builds Read labels from the file basename", () => {
    const read = getToolView("Read");
    const tool = { input: { file_path: "/a/b/c.ts" } };
    expect(read.label(tool)).toEqual({ verb: "Read", file: "c.ts" });
    expect(read.runningLabel(tool)).toEqual({ verb: "Reading", file: "c.ts" });
    expect(read.filePath(tool)).toBe("/a/b/c.ts");
  });

  it("computes Edit diff stats", () => {
    const stats = getToolView("Edit").stats({ input: { old_string: "a\nb", new_string: "a\nb\nc" } });
    expect(stats).toEqual({ add: 1, del: 0 });
  });

  it("summarizes git verbs for Bash, else Ran", () => {
    const bash = getToolView("Bash");
    expect(bash.label({ name: "Bash", input: { command: "git push origin dev" }, result: { isError: false } }).verb).toBe("Pushed");
    expect(bash.label({ name: "Bash", input: { command: "ls -la" } })).toEqual({ verb: "Ran", file: "ls -la" });
  });
});
