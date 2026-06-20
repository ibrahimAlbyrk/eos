import { describe, it, expect } from "vitest";
import { toolDisplayName } from "./toolDisplayName.js";

describe("toolDisplayName", () => {
  it("renders mcp tools as 'server · action'", () => {
    expect(toolDisplayName("mcp__context7__query-docs")).toBe("context7 · query-docs");
  });

  it("turns underscores in the action into spaces", () => {
    expect(toolDisplayName("mcp__orchestrator__send_message_to_parent")).toBe("orchestrator · send message to parent");
  });

  it("leaves the server token (with its own underscores) intact", () => {
    expect(toolDisplayName("mcp__claude_ai_Gmail__search_threads")).toBe("claude_ai_Gmail · search threads");
  });

  it("passes non-mcp names through unchanged", () => {
    expect(toolDisplayName("Read")).toBe("Read");
    expect(toolDisplayName("TodoWrite")).toBe("TodoWrite");
  });

  it("is safe for empty / nullish input", () => {
    expect(toolDisplayName("")).toBe("");
    expect(toolDisplayName(undefined)).toBe("");
    expect(toolDisplayName(null)).toBe("");
  });
});
