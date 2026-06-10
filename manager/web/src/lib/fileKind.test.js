import { describe, it, expect } from "vitest";
import { fileKind } from "./fileKind.js";

describe("fileKind", () => {
  it("classifies known extensions case-insensitively", () => {
    expect(fileKind("/a/b/doc.PDF")).toBe("pdf");
    expect(fileKind("/a/game.html")).toBe("html");
    expect(fileKind("/a/page.htm")).toBe("html");
    expect(fileKind("/a/pic.jpeg")).toBe("image");
    expect(fileKind("/a/clip.mov")).toBe("video");
    expect(fileKind("/a/song.m4a")).toBe("audio");
  });

  it("defaults to text for unknown or missing extensions", () => {
    expect(fileKind("/a/main.ts")).toBe("text");
    expect(fileKind("/a/Makefile")).toBe("text");
    expect(fileKind("/a/file.tar.gz")).toBe("text");
  });
});
