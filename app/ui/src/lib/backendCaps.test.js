import { describe, it, expect } from "vitest";
import { backendCaps, backendBilled, applyDescriptors, providerOptions, backendLabel, applyProfiles, backendProfiles, profileModel } from "./backendCaps.js";

const caps = (over) => ({ interrupt: true, keystroke: true, rewind: true, runtimeModelSwitch: true, runtimePermissionSwitch: true, ...over });
const SAMPLE = [
  { kind: "claude-cli", label: "Claude CLI", enabled: true, billing: "subscription", capabilities: caps() },
  { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", capabilities: caps({ keystroke: false, rewind: false, runtimeModelSwitch: false }) },
  { kind: "openai", label: "OpenAI", enabled: false, billing: "metered", capabilities: caps({ keystroke: false, rewind: false, runtimeModelSwitch: false }) },
];

describe("backendCaps (descriptor-driven)", () => {
  it("unknown / not-yet-loaded kind falls back to PTY-permissive caps", () => {
    applyDescriptors([]);
    const pty = { keystroke: true, rewind: true, runtimeModelSwitch: true };
    expect(backendCaps("claude-cli")).toEqual(pty);
    expect(backendCaps(undefined)).toEqual(pty);
    expect(backendCaps(null)).toEqual(pty);
    expect(backendBilled("openai")).toBe(false); // unknown -> not billed on a guess
  });

  it("reads keystroke + rewind + runtimeModelSwitch from the loaded descriptor", () => {
    applyDescriptors(SAMPLE);
    expect(backendCaps("claude-cli")).toMatchObject({ keystroke: true, rewind: true, runtimeModelSwitch: true });
    expect(backendCaps("claude-sdk")).toMatchObject({ keystroke: false, rewind: false, runtimeModelSwitch: false });
  });

  it("backendBilled reflects the descriptor's billing class", () => {
    applyDescriptors(SAMPLE);
    expect(backendBilled("claude-cli")).toBe(false);
    expect(backendBilled("claude-sdk")).toBe(false);
    expect(backendBilled("openai")).toBe(true);
  });

  it("providerOptions lists only enabled providers as {value,label}", () => {
    applyDescriptors(SAMPLE);
    expect(providerOptions()).toEqual([
      { value: "claude-cli", label: "Claude CLI" },
      { value: "claude-sdk", label: "Claude SDK" },
    ]);
  });

  it("backendLabel returns the descriptor label, falling back to the raw kind", () => {
    applyDescriptors(SAMPLE);
    expect(backendLabel("claude-sdk")).toBe("Claude SDK");
    expect(backendLabel("openai")).toBe("OpenAI"); // disabled but still labelled
    expect(backendLabel("mystery")).toBe("mystery"); // unknown -> raw kind, never blank
    expect(backendLabel(undefined)).toBe("—");
  });
});

const PROFILES = [{ name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" }];

describe("backend profiles (composer profile-lane picker)", () => {
  it("applyProfiles / backendProfiles / profileModel expose the configured profiles", () => {
    applyProfiles(PROFILES);
    expect(backendProfiles()).toEqual(PROFILES);
    expect(profileModel("deepseek")).toBe("deepseek-chat");
    expect(profileModel("missing")).toBe(null);
    applyProfiles(undefined); // tolerate a missing ui-config field
    expect(backendProfiles()).toEqual([]);
  });
});
