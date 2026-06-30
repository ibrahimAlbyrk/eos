import { describe, it, expect } from "vitest";
import { backendCaps, backendBilled, applyDescriptors, providerOptions, backendLabel, applyProfiles, backendProfiles, profileModel, providerChoices, providerSpawn, providerName } from "./backendCaps.js";

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

describe("providerChoices (unified spawn-picker derivation)", () => {
  // Subscription kinds (claude-sdk, claude-cli) + a configured openai profile.
  // The shipped per-model default profiles are subscription-kind and a duplicate
  // "claude-sdk" profile collides by name — all must collapse away.
  const DESC = [
    { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", capabilities: {} },
    { kind: "claude-cli", label: "Claude CLI", enabled: true, billing: "subscription", capabilities: {} },
    { kind: "openai", label: "OpenAI", enabled: false, billing: "metered", capabilities: {} },
  ];
  const PROFS = [
    { name: "claude-sdk-opus", kind: "claude-sdk", model: "opus", label: "claude-sdk-opus (opus)" },
    { name: "claude-cli-opus", kind: "claude-cli", model: "opus", label: "claude-cli-opus (opus)" },
    { name: "claude-sdk", kind: "claude-sdk", model: "opus", label: "claude-sdk (opus)" },
    { name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" },
  ];

  it("lists subscription kinds + non-subscription profiles; excludes per-model defaults; dedupes by name", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    expect(providerChoices().map((p) => p.name)).toEqual(["claude-sdk", "claude-cli", "deepseek"]);
  });

  it("providerName shows the bare provider name, never the model", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    const [sdk, , deepseek] = providerChoices();
    // subscription → clean descriptor label; profile → bare name (label embeds model)
    expect(providerName(sdk)).toBe("Claude SDK");
    expect(providerName(deepseek)).toBe("deepseek");
    expect(providerName(null)).toBe(null);
  });

  it("providerSpawn applies kind-vs-profile precedence", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    // a subscription kind backed by a same-name operator profile spawns via that profile
    expect(providerSpawn("claude-sdk")).toEqual({ backendKind: null, backendProfile: "claude-sdk", model: "opus" });
    // a bare subscription kind with no operator profile spawns via the kind
    expect(providerSpawn("claude-cli")).toEqual({ backendKind: "claude-cli", backendProfile: null, model: null });
    // an API profile spawns via the profile, carrying its pinned model default
    expect(providerSpawn("deepseek")).toEqual({ backendKind: null, backendProfile: "deepseek", model: "deepseek-chat" });
  });
});
