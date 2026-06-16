import { describe, it, expect } from "vitest";
import {
  defaultToolExpanded,
  defaultGroupOpen,
  VERBOSE_ENABLED_KEY,
  VERBOSE_MODE_KEY,
  VERBOSE_TOOLS_KEY,
  VERBOSE_GROUP_EXPANDED_KEY,
} from "./toolExpansion.js";

describe("defaultToolExpanded", () => {
  it("collapses everything while verbose is off", () => {
    expect(defaultToolExpanded("Bash", {})).toBe(false);
    expect(defaultToolExpanded("Bash", undefined)).toBe(false);
    expect(defaultToolExpanded("Bash", { [VERBOSE_MODE_KEY]: "expanded" })).toBe(false);
  });

  it("verbose on with default mode expands everything", () => {
    const s = { [VERBOSE_ENABLED_KEY]: true };
    expect(defaultToolExpanded("Bash", s)).toBe(true);
    expect(defaultToolExpanded("Read", s)).toBe(true);
  });

  it("selectedExpanded expands only the selected tools", () => {
    const s = { [VERBOSE_ENABLED_KEY]: true, [VERBOSE_MODE_KEY]: "selectedExpanded", [VERBOSE_TOOLS_KEY]: ["Bash"] };
    expect(defaultToolExpanded("Bash", s)).toBe(true);
    expect(defaultToolExpanded("Read", s)).toBe(false);
  });

  it("selectedCollapsed collapses only the selected tools", () => {
    const s = { [VERBOSE_ENABLED_KEY]: true, [VERBOSE_MODE_KEY]: "selectedCollapsed", [VERBOSE_TOOLS_KEY]: ["Read"] };
    expect(defaultToolExpanded("Read", s)).toBe(false);
    expect(defaultToolExpanded("Bash", s)).toBe(true);
  });

  it("unknown mode falls back to all-expanded while verbose is on", () => {
    const s = { [VERBOSE_ENABLED_KEY]: true, [VERBOSE_MODE_KEY]: "weird" };
    expect(defaultToolExpanded("Bash", s)).toBe(true);
  });
});

describe("defaultGroupOpen", () => {
  it("opens when any member tool defaults to expanded", () => {
    const s = { [VERBOSE_ENABLED_KEY]: true, [VERBOSE_MODE_KEY]: "selectedExpanded", [VERBOSE_TOOLS_KEY]: ["Edit"] };
    expect(defaultGroupOpen([{ name: "Read" }, { name: "Edit" }], s)).toBe(true);
    expect(defaultGroupOpen([{ name: "Read" }, { name: "Bash" }], s)).toBe(false);
  });

  it("handles empty/missing tool lists", () => {
    expect(defaultGroupOpen([], {})).toBe(false);
    expect(defaultGroupOpen(null, {})).toBe(false);
  });

  it("forces the group open when groupExpanded is set, regardless of tool defaults", () => {
    const s = { [VERBOSE_GROUP_EXPANDED_KEY]: true };
    expect(defaultGroupOpen([{ name: "Read" }, { name: "Bash" }], s)).toBe(true);
  });

  it("groupExpanded false leaves the derived behaviour intact", () => {
    const s = { [VERBOSE_GROUP_EXPANDED_KEY]: false };
    expect(defaultGroupOpen([{ name: "Read" }, { name: "Bash" }], s)).toBe(false);
  });
});
