import { describe, it, expect } from "vitest";
import { resolveOmnibox } from "./omnibox.js";

describe("resolveOmnibox", () => {
  it("opens addresses, http for local dev servers", () => {
    expect(resolveOmnibox("https://a.dev/x")).toEqual({ kind: "url", url: "https://a.dev/x" });
    expect(resolveOmnibox("github.com/eos")).toEqual({ kind: "url", url: "https://github.com/eos" });
    expect(resolveOmnibox("localhost:5173")).toEqual({ kind: "url", url: "http://localhost:5173" });
    expect(resolveOmnibox("192.168.1.4:8080")).toEqual({ kind: "url", url: "http://192.168.1.4:8080" });
    expect(resolveOmnibox("about:blank")).toEqual({ kind: "url", url: "about:blank" });
  });

  it("searches the web for anything else", () => {
    expect(resolveOmnibox("two bone ik")).toEqual({
      kind: "search", query: "two bone ik", url: "https://www.google.com/search?q=two%20bone%20ik",
    });
    expect(resolveOmnibox("stance").kind).toBe("search");
  });

  it("routes sigils to pages, files and the agent", () => {
    expect(resolveOmnibox("# stance ")).toEqual({ kind: "pages", query: "stance" });
    expect(resolveOmnibox("@Solver")).toEqual({ kind: "files", query: "Solver" });
    expect(resolveOmnibox("?why does it snap")).toEqual({ kind: "ask", query: "why does it snap" });
    expect(resolveOmnibox("   ")).toBe(null);
  });
});
