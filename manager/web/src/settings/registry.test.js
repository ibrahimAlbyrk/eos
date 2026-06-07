import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";

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

  it("model section: api-key visibility derives from the provider's kind", () => {
    expect(keysOf(section("model"))).toEqual(["model.provider", "model.apiKey", "model.default"]);
    const items = section("model").groups.flatMap((g) => g.items);
    const provider = items.find((i) => i.key === "model.provider");
    expect(provider.control.options.every((o) => o.kind === "cli" || o.kind === "api")).toBe(true);
    expect(provider.control.options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["claude-cli"]);
    expect(SETTING_DEFAULTS["model.provider"]).toBe("claude-cli");
    const apiKey = items.find((i) => i.key === "model.apiKey");
    for (const o of provider.control.options) {
      expect(apiKey.visibleWhen({ "model.provider": o.value })).toBe(o.kind === "api");
    }
    expect(SETTING_DEFAULTS["model.default"]).toBe("opus");
  });
});
