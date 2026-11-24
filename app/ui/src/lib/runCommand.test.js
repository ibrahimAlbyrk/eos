import { describe, expect, it } from "vitest";
import { parseRunCommand, routineForCommand, routineNamed } from "./runCommand.js";

describe("/run in a chat", () => {
  it("reads the routine, the item, the note and show-only as the core does", () => {
    expect(parseRunCommand("/run pr-review 482 --note look at tests --show-only")).toEqual({
      routine: "pr-review", item: "482", note: "look at tests", showOnly: true,
    });
    expect(parseRunCommand("/run digest")).toEqual({ routine: "digest", item: "", note: "", showOnly: false });
  });

  it("takes only a slug-shaped word, so other text goes to the agent", () => {
    expect(parseRunCommand("/run")).toBeNull();
    expect(parseRunCommand("/run Tests")).toBeNull();
    expect(parseRunCommand("/runner x")).toBeNull();
    expect(parseRunCommand("please /run x")).toBeNull();
  });

  it("finds a routine by slug, id or name", () => {
    const list = [{ id: "rt-1", slug: "pr-review", name: "PR Review" }];
    expect(routineNamed(list, "pr-review")?.id).toBe("rt-1");
    expect(routineNamed(list, "rt-1")?.id).toBe("rt-1");
    expect(routineNamed(list, "review")).toBeNull();
    expect(routineNamed(list, "pr review")?.id).toBe("rt-1");
  });

  it("decides only once the routines are known", async () => {
    let list = null;
    const asked = parseRunCommand("/run pr-review 482");
    const loaded = await routineForCommand(asked, () => list, async () => { list = [{ id: "rt-1", slug: "pr-review" }]; });
    expect(loaded?.id).toBe("rt-1");
    expect(await routineForCommand(parseRunCommand("/run tests"), () => list, async () => {})).toBeNull();
    expect(await routineForCommand(asked, () => null, async () => {})).toBeUndefined();
  });
});
