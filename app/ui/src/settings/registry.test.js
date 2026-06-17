import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";
import { applyBackends } from "../lib/models.js";

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

  it("model section: provider picks a backend profile, default is server-resolved", () => {
    applyBackends([]); // no profiles loaded yet → only the default option
    expect(keysOf(section("model"))).toEqual(["model.backendProfile", "model.default"]);
    const provider = section("model").groups.flatMap((g) => g.items).find((i) => i.key === "model.backendProfile");
    expect(provider.control.options.map((o) => o.value)).toEqual([""]);
    expect(SETTING_DEFAULTS["model.backendProfile"]).toBe("");
    expect(SETTING_DEFAULTS["model.default"]).toBe("opus");
  });

  it("provider options include the backend profiles applyBackends() loaded", () => {
    applyBackends([
      { name: "claude-sdk-opus", kind: "claude-sdk", model: "opus", costMode: "included" },
      { name: "deepseek", kind: "openai", model: "x", costMode: "billed" },
    ]);
    const provider = section("model").groups.flatMap((g) => g.items).find((i) => i.key === "model.backendProfile");
    expect(provider.control.options.map((o) => o.value)).toEqual(["", "claude-sdk-opus", "deepseek"]);
    expect(provider.control.options.find((o) => o.value === "deepseek").hint).toBe("billed");
    expect(provider.control.options.find((o) => o.value === "claude-sdk-opus").hint).toBe("included");
    applyBackends([]); // reset module state for any later test
  });
});
