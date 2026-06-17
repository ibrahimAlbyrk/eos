import { describe, it, expect } from "vitest";
import { backendCaps } from "./backendCaps.js";

describe("backendCaps", () => {
  it("claude-cli / undefined / null -> full PTY caps", () => {
    const pty = { keystroke: true, runtimeModelSwitch: true };
    expect(backendCaps("claude-cli")).toEqual(pty);
    expect(backendCaps(undefined)).toEqual(pty);
    expect(backendCaps(null)).toEqual(pty);
  });

  it("structured backends -> no keystroke, no runtime model switch", () => {
    const structured = { keystroke: false, runtimeModelSwitch: false };
    for (const k of ["claude-sdk", "anthropic-api", "openai", "codex", "deepseek", "kimi"]) {
      expect(backendCaps(k)).toEqual(structured);
    }
  });
});
