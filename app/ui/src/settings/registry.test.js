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

  it("archive group lives in General: retention select, purge-on-close toggle, ⌘W action", () => {
    const keys = keysOf(section("general"));
    expect(keys).toEqual(expect.arrayContaining(["archive.retention", "archive.purgeOnAppClose", "archive.cmdW"]));
    expect(SETTING_DEFAULTS["archive.retention"]).toBe("off");
    expect(SETTING_DEFAULTS["archive.purgeOnAppClose"]).toBe(false);
    expect(SETTING_DEFAULTS["archive.cmdW"]).toBe("archive");
    const items = section("general").groups.find((g) => g.title === "Archive").items;
    expect(items.find((i) => i.key === "archive.retention").control.options.map((o) => o.value))
      .toEqual(["off", "daily", "weekly", "monthly"]);
    expect(items.find((i) => i.key === "archive.cmdW").control.options.map((o) => o.value))
      .toEqual(["archive", "delete"]);
  });

  it("model section renders a custom Component (the shared provider/model picker) and keeps its defaults", () => {
    const model = section("model");
    expect(model.groups).toBeUndefined();
    expect(typeof model.Component).toBe("function"); // ModelSettings — same picker as the composer
    expect(SETTING_DEFAULTS["model.provider"]).toBe("claude-sdk");
    expect(SETTING_DEFAULTS["model.default"]).toBe("opus");
  });
});
