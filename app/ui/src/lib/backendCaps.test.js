import { describe, it, expect } from "vitest";
import { backendCaps, backendBilled, applyDescriptors, providerOptions, backendLabel, applyProfiles, backendProfiles, profileModel, providerChoices, providerSpawn, providerName, canSwitchProvider, providerSwitchTargets } from "./backendCaps.js";

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

describe("running-worker provider switch (canSwitchProvider / providerSwitchTargets)", () => {
  // claude-cli + claude-sdk (subscription) and a configured openai profile
  // (deepseek). openai is metered+enabled (selectable) but never appears as a raw
  // kind; codex is metered+disabled.
  const DESC = [
    { kind: "claude-cli", label: "Claude CLI", enabled: true, billing: "subscription", capabilities: {} },
    { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", capabilities: {} },
    { kind: "openai", label: "OpenAI API", enabled: true, billing: "metered", capabilities: {} },
    { kind: "codex", label: "Codex", enabled: false, billing: "metered", capabilities: {} },
  ];
  const PROFS = [{ name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" }];

  it("canSwitchProvider mirrors the daemon's coarse handoff rule", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    expect(canSwitchProvider("claude-cli", "claude-cli")).toEqual({ ok: false, reason: "already on this provider" });
    expect(canSwitchProvider("claude-cli", "claude-sdk")).toEqual({ ok: true }); // same store (subscription)
    expect(canSwitchProvider("claude-cli", "openai").ok).toBe(false); // cross store (metered) blocked
    expect(canSwitchProvider("openai", "codex")).toEqual({ ok: false, reason: "provider is not enabled" });
    expect(canSwitchProvider("mystery", "claude-cli")).toEqual({ ok: true }); // not loaded -> don't disable on a guess
    expect(canSwitchProvider(null, "claude-cli")).toEqual({ ok: true });
  });

  it("provider switch list is providerChoices() — configured providers only, no raw unconfigured kinds", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    const names = providerSwitchTargets("claude-cli").map((p) => p.name);
    expect(names).toEqual(providerChoices().map((p) => p.name));
    expect(names).toEqual(["claude-cli", "claude-sdk", "deepseek"]);
    // the unconfigured raw kinds the old picker showed are gone
    expect(names).not.toContain("openai");
    expect(names).not.toContain("anthropic-api");
    expect(names).not.toContain("codex");
  });

  it("annotates the current backend and greys cross-store targets", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    const t = providerSwitchTargets("claude-cli");
    const by = (name) => t.find((p) => p.name === name);
    expect(by("claude-cli").current).toBe(true);
    expect(by("claude-cli").disabled).toBe(false);
    expect(by("claude-sdk")).toMatchObject({ current: false, disabled: false });
    expect(by("deepseek").disabled).toBe(true);
    expect(by("deepseek").reason).toMatch(/store/);
  });

  it("matches a profile-spawned worker to its choice by kind (deepseek worker → backend_kind openai)", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    const t = providerSwitchTargets("openai");
    const by = (name) => t.find((p) => p.name === name);
    expect(by("deepseek").current).toBe(true); // the running deepseek worker is the current entry
    expect(by("claude-cli").disabled).toBe(true); // cross store
  });
});
