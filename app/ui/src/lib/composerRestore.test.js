import { describe, it, expect } from "vitest";
import { shouldApplyPendingText } from "./composerRestore.js";

describe("shouldApplyPendingText", () => {
  it("no pendingText → don't apply", () => {
    expect(shouldApplyPendingText(null, "")).toBe(false);
  });

  it("rewind restore (no guard) always replaces, even over a draft", () => {
    expect(shouldApplyPendingText({ content: "x" }, "my draft")).toBe(true);
    expect(shouldApplyPendingText({ content: "x" }, "")).toBe(true);
  });

  it("recall restore applies into an empty (or whitespace-only) editor", () => {
    expect(shouldApplyPendingText({ content: "x", guard: "recall" }, "")).toBe(true);
    expect(shouldApplyPendingText({ content: "x", guard: "recall" }, "   ")).toBe(true);
  });

  it("recall restore does NOT clobber a draft typed after sending", () => {
    expect(shouldApplyPendingText({ content: "x", guard: "recall" }, "typed after sending")).toBe(false);
  });
});
