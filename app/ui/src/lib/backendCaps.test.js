import { describe, it, expect } from "vitest";
import { backendCaps, backendBilled, applyDescriptors, providerOptions, backendLabel, applyProfiles, backendProfiles, profileModel, providerChoices, providerSpawn, providerName, canSwitchProvider, providerSwitchTargets, hasProviderSwitchTarget, runningProviderChoice, runningProviderLabel } from "./backendCaps.js";

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
  // claude-cli + claude-sdk (subscription, claude-transcript store) and a configured
  // openai profile (deepseek). openai is metered+enabled (selectable) but never
  // appears as a raw kind; codex is metered+disabled.
  const DESC = [
    { kind: "claude-cli", label: "Claude CLI", enabled: true, billing: "subscription", sessionStore: "claude-transcript", capabilities: {} },
    { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", sessionStore: "claude-transcript", capabilities: {} },
    { kind: "openai", label: "OpenAI API", enabled: true, billing: "metered", sessionStore: "eos-conversation", wireDialect: "openai-chat", capabilities: {} },
    { kind: "codex", label: "Codex", enabled: false, billing: "metered", sessionStore: "eos-conversation", wireDialect: "openai-chat", capabilities: {} },
  ];
  const PROFS = [{ name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" }];

  it("canSwitchProvider mirrors the daemon's handoff rule (shared store + wire dialect)", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    expect(canSwitchProvider("claude-cli", "claude-cli")).toEqual({ ok: false, reason: "already on this provider" });
    expect(canSwitchProvider("claude-cli", "claude-sdk")).toEqual({ ok: true }); // same store (claude-transcript)
    expect(canSwitchProvider("claude-cli", "openai").ok).toBe(false); // cross store blocked
    expect(canSwitchProvider("openai", "codex")).toEqual({ ok: false, reason: "provider is not enabled" });
    expect(canSwitchProvider("mystery", "claude-cli")).toEqual({ ok: true }); // not loaded -> don't disable on a guess
    expect(canSwitchProvider(null, "claude-cli")).toEqual({ ok: true });
  });

  it("groups same-infrastructure providers (shared store + wire dialect); blocks cross-dialect", () => {
    // Two OpenAI-compatible lanes + an Anthropic-dialect lane, all on the same
    // eos-conversation store, plus a subscription lane on a different store.
    applyDescriptors([
      { kind: "openai", label: "OpenAI", enabled: true, billing: "metered", sessionStore: "eos-conversation", wireDialect: "openai-chat", capabilities: {} },
      { kind: "codex", label: "Codex", enabled: true, billing: "metered", sessionStore: "eos-conversation", wireDialect: "openai-chat", capabilities: {} },
      { kind: "anthropic-api", label: "Anthropic API", enabled: true, billing: "metered", sessionStore: "eos-conversation", wireDialect: "anthropic", capabilities: {} },
      { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", sessionStore: "claude-transcript", capabilities: {} },
    ]);
    // shared store AND dialect → same infrastructure, switchable
    expect(canSwitchProvider("openai", "codex")).toEqual({ ok: true });
    // shared store, different wire dialect → cross-infrastructure block
    expect(canSwitchProvider("openai", "anthropic-api")).toEqual({ ok: false, reason: "different wire dialect — no live handoff" });
    // different store entirely → cross-infrastructure block
    expect(canSwitchProvider("openai", "claude-sdk").ok).toBe(false);
  });

  it("hasProviderSwitchTarget: true when a same-infra sibling exists, false when only cross-infra", () => {
    // deepseek (openai) + mycodex (codex) are both OpenAI-compatible → siblings.
    applyDescriptors(DESC.map((d) => (d.kind === "codex" ? { ...d, enabled: true } : d)));
    applyProfiles([
      { name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" },
      { name: "mycodex", kind: "codex", model: "gpt-5-codex", label: "mycodex (gpt-5-codex)" },
    ]);
    expect(hasProviderSwitchTarget("claude-cli")).toBe(true); // claude-sdk shares the store
    expect(hasProviderSwitchTarget("openai")).toBe(true); // codex shares store + dialect

    // Only a subscription lane + a lone openai profile → no same-infra sibling.
    applyDescriptors([
      { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", sessionStore: "claude-transcript", capabilities: {} },
      { kind: "openai", label: "OpenAI", enabled: true, billing: "metered", sessionStore: "eos-conversation", wireDialect: "openai-chat", capabilities: {} },
    ]);
    applyProfiles([{ name: "deepseek", kind: "openai", model: "deepseek-chat", label: "deepseek (deepseek-chat)" }]);
    expect(hasProviderSwitchTarget("claude-sdk")).toBe(false); // only cross-store deepseek to offer
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

  it("runningProviderChoice maps a worker to its provider choice (profile first, else kind)", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    // a deepseek worker (backend_kind openai + profile deepseek) → the non-subscription API choice
    expect(runningProviderChoice({ backend_kind: "openai", backend_profile: "deepseek" }))
      .toMatchObject({ name: "deepseek", kind: "openai", subscription: false });
    // a subscription worker (no profile) → matched by kind
    expect(runningProviderChoice({ backend_kind: "claude-sdk", backend_profile: null }))
      .toMatchObject({ name: "claude-sdk", subscription: true });
    expect(runningProviderChoice(null)).toBe(null);
  });

  it("runningProviderLabel shows the provider name on the live worker's pill (not the raw kind)", () => {
    applyDescriptors(DESC);
    applyProfiles(PROFS);
    // a deepseek worker (backend_kind openai) reads "deepseek", not "OpenAI API"
    expect(runningProviderLabel({ backend_kind: "openai", backend_profile: "deepseek" })).toBe("deepseek");
    // a subscription worker reads the clean kind label
    expect(runningProviderLabel({ backend_kind: "claude-sdk", backend_profile: null })).toBe("Claude SDK");
    expect(runningProviderLabel({ backend_kind: "claude-cli", backend_profile: null })).toBe("Claude CLI");
    expect(runningProviderLabel(null)).toBe("—");
  });
});
