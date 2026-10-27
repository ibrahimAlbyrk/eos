import { describe, it, expect } from "vitest";
import { resolveTerminalLink } from "./terminalLinks.js";

describe("resolveTerminalLink", () => {
  it("resolves web links", () => {
    expect(resolveTerminalLink("https://example.com/a?b=1")).toEqual({ kind: "web", url: "https://example.com/a?b=1" });
    expect(resolveTerminalLink("mailto:a@b.co")).toEqual({ kind: "web", url: "mailto:a@b.co" });
  });
  it("resolves file links to a decoded absolute path", () => {
    expect(resolveTerminalLink("file:///Users/me/My%20Dir/a.ts")).toEqual({ kind: "file", path: "/Users/me/My Dir/a.ts" });
  });
  it("rejects other schemes and junk", () => {
    expect(resolveTerminalLink("javascript:alert(1)")).toBeNull();
    expect(resolveTerminalLink("not a url")).toBeNull();
  });
});
