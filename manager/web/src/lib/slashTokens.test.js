import { describe, it, expect } from "vitest";
import { findSlashTokens } from "./slashTokens.js";

const names = new Set(["clear", "commit", "video-reader"]);

describe("findSlashTokens", () => {
  it("matches a command at the start of the text", () => {
    expect(findSlashTokens("/clear", names)).toEqual([{ start: 0, end: 6, name: "clear" }]);
  });

  it("matches a command followed by arguments", () => {
    expect(findSlashTokens("/commit fix the bug", names)).toEqual([
      { start: 0, end: 7, name: "commit" },
    ]);
  });

  it("matches after a space and after a newline", () => {
    expect(findSlashTokens("run /clear now", names)).toEqual([
      { start: 4, end: 10, name: "clear" },
    ]);
    expect(findSlashTokens("first\n/commit msg", names)).toEqual([
      { start: 6, end: 13, name: "commit" },
    ]);
  });

  it("ignores unknown names", () => {
    expect(findSlashTokens("/unknown stuff", names)).toEqual([]);
  });

  it("ignores filesystem paths — segments are not commands", () => {
    expect(findSlashTokens("look in /usr/bin please", names)).toEqual([]);
    expect(findSlashTokens("/clear/extra", names)).toEqual([]);
  });

  it("requires a boundary before the slash", () => {
    expect(findSlashTokens("foo/clear", names)).toEqual([]);
  });

  it("finds multiple commands", () => {
    expect(findSlashTokens("/clear then /commit", names)).toEqual([
      { start: 0, end: 6, name: "clear" },
      { start: 12, end: 19, name: "commit" },
    ]);
  });

  it("matches names containing dashes", () => {
    expect(findSlashTokens("/video-reader aktif et", names)).toEqual([
      { start: 0, end: 13, name: "video-reader" },
    ]);
  });

  it("works with a Map as the name collection", () => {
    const map = new Map([["clear", { name: "clear" }]]);
    expect(findSlashTokens("/clear", map)).toEqual([{ start: 0, end: 6, name: "clear" }]);
  });
});
