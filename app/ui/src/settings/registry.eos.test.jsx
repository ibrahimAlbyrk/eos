import { describe, it, expect, vi } from "vitest";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS } from "./registry.jsx";
import { SettingsGroups } from "./SettingsGroups.jsx";

const group = SETTINGS_SECTIONS.find((s) => s.id === "general").groups.find((g) => g.title === "Eos preview");

// The control the row draws, as React would render it.
function controlOf(settings, setSetting) {
  const [rendered] = SettingsGroups({ groups: [group], settings, setSetting });
  const [row] = rendered.props.children[1];
  const control = row.props.children[1];
  return control.type(control.props);
}

describe("Settings › General › Eos preview", () => {
  it("is one toggle, off by default", () => {
    expect(group.items.map((i) => i.key)).toEqual(["eos.preview"]);
    expect(group.items[0].label).toBe("Eos preview");
    expect(group.items[0].control.type).toBe("toggle");
    expect(SETTING_DEFAULTS["eos.preview"]).toBe(false);
  });

  it("toggles the key", () => {
    const setSetting = vi.fn();
    controlOf({}, setSetting).props.onClick();
    expect(setSetting).toHaveBeenLastCalledWith("eos.preview", true);
    controlOf({ "eos.preview": true }, setSetting).props.onClick();
    expect(setSetting).toHaveBeenLastCalledWith("eos.preview", false);
  });
});
