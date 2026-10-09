import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS_SECTIONS, SETTING_DEFAULTS, LocationTest, locationText } from "./registry.jsx";
import { CONTROLS } from "./controls.jsx";

const group = SETTINGS_SECTIONS.find((s) => s.id === "general").groups.find((g) => g.title === "Visual answers");
const item = (key) => group.items.find((i) => i.key === key);

describe("Settings › General › Visual answers", () => {
  it("has the level, apps, location and logo key rows, all under the genui block", () => {
    expect(group.items.map((i) => i.key)).toEqual(["genui.level", "genui.apps", "genui.locationShare", "genui.locationTest", "genui.logoDevKey"]);
    expect(item("genui.level").control.options.map((o) => o.label)).toEqual(["Rich", "Balanced", "Text only"]);
    expect(SETTING_DEFAULTS["genui.level"]).toBe("balanced");
    expect(SETTING_DEFAULTS["genui.apps"]).toBe(true);
    expect(SETTING_DEFAULTS["genui.locationShare"]).toBe(false);
  });

  it("apps hide at Text only; the location test shows only while sharing is on", () => {
    expect(item("genui.apps").visibleWhen({ "genui.level": "text" })).toBe(false);
    expect(item("genui.apps").visibleWhen({ "genui.level": "balanced" })).toBe(true);
    expect(item("genui.locationTest").visibleWhen({ "genui.locationShare": false })).toBe(false);
    expect(item("genui.locationTest").visibleWhen({ "genui.locationShare": true })).toBe(true);
  });

  it("each row's control renders", () => {
    for (const key of ["genui.level", "genui.apps", "genui.locationShare", "genui.locationTest", "genui.logoDevKey"]) {
      const it = item(key);
      const Control = CONTROLS[it.control.type];
      expect(Control, key).toBeTruthy();
      const html = renderToStaticMarkup(<Control {...it.control} value={it.defaultValue} onChange={() => {}} />);
      expect(html.length).toBeGreaterThan(0);
    }
    const seg = renderToStaticMarkup((() => {
      const it = item("genui.level");
      const Control = CONTROLS.segmented;
      return <Control {...it.control} value="balanced" onChange={() => {}} />;
    })());
    expect(seg).toContain("Text only");
    expect(seg).toMatch(/aria-checked="true"[^>]*>Balanced/);
  });

  it("every row's description is searchable text (the Test button is a control, not a description)", () => {
    for (const it of group.items) expect(typeof (it.description ?? ""), it.key).toBe("string");
    expect(renderToStaticMarkup(<CONTROLS.custom Component={LocationTest} value={null} onChange={() => {}} />)).toContain(">Test</button>");
  });

  it("the Test button reads the location; the result reads as an area", () => {
    const html = renderToStaticMarkup(<LocationTest />);
    expect(html).toContain(">Test</button>");
    expect(locationText({ lat: 40.98, lon: 29.02, accuracy: 35.4, at: 1, area: { district: "Kadıköy", city: "İstanbul" } })).toBe("Kadıköy, İstanbul · ±35 m");
    expect(locationText({ lat: 40.98123, lon: 29.02456, accuracy: 10, at: 1 })).toBe("40.981, 29.025 · ±10 m");
    expect(locationText(null)).toBe("");
  });
});
