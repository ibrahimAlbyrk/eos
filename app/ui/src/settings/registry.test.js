import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";
import { applyDescriptors } from "../lib/backendCaps.js";

const section = (id) => SETTINGS_SECTIONS.find((s) => s.id === id);
const keysOf = (s) => (s?.groups ?? []).flatMap((g) => g.items).map((i) => i.key);

describe("settings registry", () => {
  it("theme lives in General and defaults to system", () => {
    expect(keysOf(section("general"))).toContain("appearance.theme");
    expect(SETTING_DEFAULTS["appearance.theme"]).toBe("system");
    const item = section("general").groups.flatMap((g) => g.items).find((i) => i.key === "appearance.theme");
    expect(item.control.options.map((o) => o.value)).toEqual(["system", "light", "dark"]);
  });

  it("verbose settings moved to the Code section, keys unchanged", () => {
    const codeKeys = keysOf(section("code"));
    expect(codeKeys).toEqual(expect.arrayContaining(["verbose.enabled", "verbose.mode", "verbose.tools"]));
    expect(keysOf(section("general"))).not.toContain("verbose.enabled");
  });

  it("model section: provider is descriptor-driven (enabled providers only), default SDK", () => {
    expect(keysOf(section("model"))).toEqual(["model.provider", "model.default"]);
    applyDescriptors([
      { kind: "claude-sdk", label: "Claude SDK", enabled: true, billing: "subscription", capabilities: {} },
      { kind: "claude-cli", label: "Claude CLI", enabled: true, billing: "subscription", capabilities: {} },
      { kind: "openai", label: "OpenAI", enabled: false, billing: "metered", capabilities: {} },
    ]);
    const provider = section("model").groups.flatMap((g) => g.items).find((i) => i.key === "model.provider");
    expect(provider.control.options).toEqual([
      { value: "claude-sdk", label: "Claude SDK" },
      { value: "claude-cli", label: "Claude CLI" },
    ]); // disabled "openai" excluded
    expect(SETTING_DEFAULTS["model.provider"]).toBe("claude-sdk");
    expect(SETTING_DEFAULTS["model.default"]).toBe("opus");
  });
});
