import { describe, it, expect } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";

const section = (id) => SETTINGS_SECTIONS.find((s) => s.id === id);
const keysOf = (s) => (s?.groups ?? []).flatMap((g) => g.items).map((i) => i.key);

describe("settings registry", () => {
  it("has no appearance/theme setting (dark only)", () => {
    expect(keysOf(section("general"))).not.toContain("appearance.theme");
    expect(SETTING_DEFAULTS["appearance.theme"]).toBeUndefined();
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

  it("accounts section renders a custom Component and owns no settings.json keys", () => {
    const accounts = section("accounts");
    expect(accounts.groups).toBeUndefined();
    expect(typeof accounts.Component).toBe("function"); // AccountsSettings — accounts live in config.json + Keychain
    expect(keysOf(accounts)).toEqual([]);
  });

  it("the old model + anthropic sections are gone; composer defaults stay", () => {
    expect(section("model")).toBeUndefined();
    expect(section("anthropic")).toBeUndefined();
    expect(SETTING_DEFAULTS["model.provider"]).toBe("claude");
    expect(SETTING_DEFAULTS["model.default"]).toBe("opus");
    expect(SETTING_DEFAULTS["onboarding.dismissed"]).toBe(false);
  });

  it("profile comes first, renders a custom Component and owns no settings.json keys", () => {
    const profile = section("profile");
    expect(SETTINGS_SECTIONS[0].id).toBe("profile");
    expect(profile.groups).toBeUndefined();
    expect(typeof profile.Component).toBe("function"); // ProfileSettings — ~/.eos/profile via /api/profile
    expect(keysOf(profile)).toEqual([]);
  });

  it("usage section renders a custom Component and owns no settings.json keys", () => {
    const usage = section("usage");
    expect(usage.groups).toBeUndefined();
    expect(typeof usage.Component).toBe("function"); // UsageSettings — fetched live, never persisted
    expect(keysOf(usage)).toEqual([]);
  });
});
