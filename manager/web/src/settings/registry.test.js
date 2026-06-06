import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";

const section = (id) => SETTINGS_SECTIONS.find((s) => s.id === id);
const keysOf = (s) => (s?.groups ?? []).flatMap((g) => g.items).map((i) => i.key);

describe("settings registry", () => {
  it("theme lives in General and defaults to system", () => {
    expect(keysOf(section("general"))).toContain("appearance.theme");
    expect(SETTING_DEFAULTS["appearance.theme"]).toBe("system");
    const item = section("general").groups.flatMap((g) => g.items).find((i) => i.key === "appearance.theme");
    expect(item.control.options.map((o) => o.value)).toEqual(["system", "dark", "light"]);
  });

  it("verbose settings moved to the Code section, keys unchanged", () => {
    const codeKeys = keysOf(section("code"));
    expect(codeKeys).toEqual(expect.arrayContaining(["verbose.enabled", "verbose.mode", "verbose.tools"]));
    expect(keysOf(section("general"))).not.toContain("verbose.enabled");
  });
});
