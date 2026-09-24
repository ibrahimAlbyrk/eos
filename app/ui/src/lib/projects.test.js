import { describe, it, expect } from "vitest";
import { projectForPath, projectLabel, tildePath, remoteSlug, projectChoices } from "./projects.js";

const projects = [{ id: "p", name: "Dear Souls", folders: ["/Users/me/ds", "/Users/me/lib"] }];

describe("projects helpers", () => {
  it("projectForPath matches any folder", () => {
    expect(projectForPath(projects, "/Users/me/lib")?.id).toBe("p");
    expect(projectForPath(projects, "/Users/me/x")).toBe(null);
    expect(projectForPath(projects, null)).toBe(null);
  });

  it("projectLabel falls back to the folder name", () => {
    expect(projectLabel(projects[0], "/Users/me/ds")).toBe("Dear Souls");
    expect(projectLabel(null, "/Users/me/eos")).toBe("eos");
  });

  it("tildePath abbreviates the home dir", () => {
    expect(tildePath("/Users/me/Projects/x")).toBe("~/Projects/x");
    expect(tildePath("/opt/x")).toBe("/opt/x");
  });

  it("remoteSlug parses ssh and https remotes", () => {
    expect(remoteSlug("git@github.com:DTeam-dev/dear-souls.git")).toBe("DTeam-dev/dear-souls");
    expect(remoteSlug("https://github.com/DTeam-dev/dear-souls")).toBe("DTeam-dev/dear-souls");
    expect(remoteSlug(null)).toBe(null);
  });

  it("projectChoices lists projects then unowned recents", () => {
    const out = projectChoices(projects, ["/Users/me/lib", "/Users/me/eos"]);
    expect(out.map((c) => c.name)).toEqual(["Dear Souls", "eos"]);
    expect(out[0].path).toBe("/Users/me/ds");
  });
});
