import { describe, it, expect } from "vitest";
import { folderGroups } from "./folderGroups.js";

describe("folderGroups", () => {
  it("groups sessions by folder, then appends session-less folders", () => {
    const sessions = [
      { id: "a", cwd: "/p/api" },
      { id: "b", cwd: "/p/web" },
      { id: "c", cwd: "/p/api" },
    ];
    const g = folderGroups(sessions, ["/p/web", "/p/docs"]);
    expect(g.map((x) => x.path)).toEqual(["/p/api", "/p/web", "/p/docs"]);
    expect(g[0].roots.map((r) => r.id)).toEqual(["a", "c"]);
    expect(g[0].name).toBe("api");
    expect(g[2].roots).toEqual([]);
  });

  it("lists folders alone when no session is open", () => {
    expect(folderGroups([], ["/x/one"])).toEqual([{ key: "/x/one", path: "/x/one", name: "one", roots: [] }]);
  });
});
