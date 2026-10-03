import { describe, it, expect } from "vitest";
import { mergePageBody } from "./pageMerge.js";

const BASE = "# Plan\n\n- [ ] a\n- [ ] b\n\nnotes\n";

describe("mergePageBody", () => {
  it("takes the side that changed when only one did", () => {
    expect(mergePageBody(BASE, BASE, "remote")).toBe("remote");
    expect(mergePageBody(BASE, "local", BASE)).toBe("local");
  });

  it("replays the user's edit onto the agent's version when they touch different lines", () => {
    const local = BASE.replace("notes", "my notes");
    const remote = BASE.replace("- [ ] a", "- [x] a");
    expect(mergePageBody(BASE, local, remote)).toBe("# Plan\n\n- [x] a\n- [ ] b\n\nmy notes\n");
  });

  it("keeps an agent's append under a user's edit higher up", () => {
    const local = BASE.replace("# Plan", "# Plan v2");
    const remote = `${BASE}\n## Findings\n\nfound\n`;
    expect(mergePageBody(BASE, local, remote)).toBe(`${local}\n## Findings\n\nfound\n`);
  });

  it("gives up on overlapping edits", () => {
    expect(mergePageBody(BASE, BASE.replace("- [ ] a", "- [ ] A"), BASE.replace("- [ ] a", "- [x] a"))).toBe(null);
  });
});
