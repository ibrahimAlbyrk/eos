import { describe, it, expect } from "vitest";
import { composerCwd } from "./composerFolder.js";
import { permanentDeleteMessage } from "./archive.js";

describe("composerCwd", () => {
  it("picked folder, else the most recent one", () => {
    expect(composerCwd({ cwd: "/a" }, ["/r"])).toBe("/a");
    expect(composerCwd({ cwd: null }, ["/r"])).toBe("/r");
  });

  it("null under No folder, even with a folder and recents around", () => {
    expect(composerCwd({ cwd: "/a", noFolder: true }, ["/r"])).toBe(null);
  });

  it("null when no folder is known at all", () => {
    expect(composerCwd({ cwd: null }, [])).toBe(null);
  });
});

describe("permanentDeleteMessage — No folder", () => {
  it("says the folder's files go too", () => {
    expect(permanentDeleteMessage("x", 1, true)).toContain("every file in its folder");
    expect(permanentDeleteMessage("x", 1)).toContain("worktree is removed");
  });
});
