import { describe, it, expect } from "vitest";
import { assignIdentities, SUBAGENT_COLORS, SUBAGENT_GLYPHS } from "./subagentIdentity.js";

const ids = (n) => Array.from({ length: n }, (_, i) => `toolu_${i.toString(36)}x${(i * 7919).toString(16)}`);

describe("assignIdentities", () => {
  it("is deterministic for the same ids", () => {
    const a = assignIdentities(ids(5));
    const b = assignIdentities(ids(5));
    expect([...a.values()]).toEqual([...b.values()]);
  });

  it("never repeats a color or a glyph within any 8 consecutive subagents", () => {
    const list = ids(30);
    const out = assignIdentities(list);
    for (let i = 0; i + SUBAGENT_COLORS.length <= list.length; i++) {
      const window = list.slice(i, i + SUBAGENT_COLORS.length).map((id) => out.get(id));
      expect(new Set(window.map((x) => x.color)).size).toBe(SUBAGENT_COLORS.length);
      expect(new Set(window.map((x) => x.glyph)).size).toBe(SUBAGENT_GLYPHS.length);
    }
  });

  it("keeps earlier picks when more subagents join", () => {
    const first = assignIdentities(ids(3));
    const more = assignIdentities(ids(6));
    for (const [id, identity] of first) expect(more.get(id)).toEqual(identity);
  });

  it("returns a palette hex alongside the color id", () => {
    const [identity] = assignIdentities(["toolu_one"]).values();
    expect(SUBAGENT_COLORS.find((c) => c.id === identity.color).hex).toBe(identity.hex);
    expect(SUBAGENT_GLYPHS).toContain(identity.glyph);
  });
});
