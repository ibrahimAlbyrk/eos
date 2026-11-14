import { describe, it, expect } from "vitest";
import { editTarget, isOutsideFolder, permissionTarget } from "./permissionTarget.js";

describe("permissionTarget", () => {
  it("reads the path a file edit writes", () => {
    expect(editTarget("Write", { file_path: "/a/b.txt" })).toBe("/a/b.txt");
    expect(editTarget("NotebookEdit", { notebook_path: "/a/n.ipynb" })).toBe("/a/n.ipynb");
    expect(editTarget("Read", { file_path: "/a/b.txt" })).toBeNull();
  });

  it("tells a path outside the folder", () => {
    expect(isOutsideFolder("/work/app/src/a.rs", "/work/app")).toBe(false);
    expect(isOutsideFolder("/work/application/a.rs", "/work/app")).toBe(true);
    expect(isOutsideFolder("/work/app/../other/a.rs", "/work/app")).toBe(true);
    expect(isOutsideFolder("/work/app", "/work/app")).toBe(true);
    expect(isOutsideFolder("src/a.rs", "/work/app")).toBe(false);
    expect(isOutsideFolder("/x/a.rs", undefined)).toBe(false);
  });

  it("marks only file edits outside the worker's folder", () => {
    const worker = { cwd: "/work/app" };
    expect(permissionTarget("Edit", { file_path: "/etc/hosts" }, worker)).toEqual({ detail: "/etc/hosts", outside: true });
    expect(permissionTarget("Edit", { file_path: "/work/app/a" }, worker).outside).toBe(false);
    expect(permissionTarget("Read", { file_path: "/etc/hosts" }, worker).outside).toBe(false);
    expect(permissionTarget("Bash", { command: "ls" }, worker)).toEqual({ detail: "ls", outside: false });
  });
});
